const express = require('express');
const { connectDB, slugify } = require('./db');

const router = express.Router();

// Helper: Transparently upgrade old schemas in response
function transformDocument(doc) {
  if (!doc) return null;
  const upgradedDoc = { ...doc };
  if (upgradedDoc.metadata) {
    upgradedDoc.metadata = { ...upgradedDoc.metadata };
    const author = upgradedDoc.metadata.author;
    if (typeof author === 'string') {
      upgradedDoc.metadata.author = {
        id: null,
        name: author,
        email: null
      };
    }
  }
  return upgradedDoc;
}

// 1. Create a new document
router.post('/documents', async (req, res) => {
  try {
    const { title, content, tags, authorName, authorEmail } = req.body;
    
    if (!title || !content || !authorName) {
      return res.status(400).json({ error: 'title, content, and authorName are required fields.' });
    }

    const database = await connectDB();
    const collection = database.collection('documents');

    let slug = slugify(title);
    
    // Check if slug is unique, append unique suffix if needed
    const existing = await collection.findOne({ slug });
    if (existing) {
      slug = `${slug}-${Date.now().toString().slice(-4)}`;
    }

    const now = new Date();
    const authorId = `user-${Date.now()}`;

    const newDoc = {
      slug,
      title,
      content,
      version: 1,
      tags: Array.isArray(tags) ? tags : [],
      metadata: {
        author: {
          id: authorId,
          name: authorName,
          email: authorEmail || null
        },
        createdAt: now,
        updatedAt: now,
        wordCount: content.split(/\s+/).filter(Boolean).length
      },
      revision_history: [
        {
          version: 1,
          updatedAt: now,
          authorId: authorId,
          contentDiff: 'Initial creation.'
        }
      ]
    };

    await collection.insertOne(newDoc);
    res.status(201).json(transformDocument(newDoc));
  } catch (error) {
    console.error('Error creating document:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. Retrieve a document by slug
router.get('/documents/:slug', async (req, res) => {
  try {
    const database = await connectDB();
    const collection = database.collection('documents');
    const doc = await collection.findOne({ slug: req.params.slug });
    
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    res.status(200).json(transformDocument(doc));
  } catch (error) {
    console.error('Error fetching document:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 3. Update a document with Optimistic Concurrency Control (OCC)
router.put('/documents/:slug', async (req, res) => {
  try {
    const slug = req.params.slug;
    const { title, content, version } = req.body;

    if (version === undefined || version === null) {
      return res.status(400).json({ error: 'version is required for optimistic concurrency control.' });
    }

    const expectedVersion = parseInt(version, 10);
    const database = await connectDB();
    const collection = database.collection('documents');

    // Differentiate between 404 (Not Found) and 409 (Conflict)
    const existing = await collection.findOne({ slug });
    if (!existing) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const nextVersion = expectedVersion + 1;
    const authorId = existing.metadata?.author?.id || 'user-editor';

    // Perform atomic conditional update
    const result = await collection.findOneAndUpdate(
      { slug, version: expectedVersion },
      {
        $set: {
          title: title !== undefined ? title : existing.title,
          content: content !== undefined ? content : existing.content,
          'metadata.updatedAt': new Date(),
          'metadata.wordCount': (content !== undefined ? content : existing.content).split(/\s+/).filter(Boolean).length
        },
        $inc: { version: 1 },
        $push: {
          revision_history: {
            $each: [{
              version: nextVersion,
              updatedAt: new Date(),
              authorId: authorId,
              contentDiff: `Updated to version ${nextVersion}`
            }],
            $slice: -20 // Capped revision history at 20 elements
          }
        }
      },
      { returnDocument: 'after' }
    );

    // Support both older and newer MongoDB Node drivers
    const updatedDoc = result && (result.value !== undefined ? result.value : result);

    if (!updatedDoc) {
      // OCC Conflict! Fetch the latest version from the database
      const latest = await collection.findOne({ slug });
      return res.status(409).json(transformDocument(latest));
    }

    res.status(200).json(transformDocument(updatedDoc));
  } catch (error) {
    console.error('Error updating document:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 4. Delete a document
router.delete('/documents/:slug', async (req, res) => {
  try {
    const database = await connectDB();
    const collection = database.collection('documents');
    const result = await collection.deleteOne({ slug: req.params.slug });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    res.status(200).json({ message: 'Document deleted successfully' });
  } catch (error) {
    console.error('Error deleting document:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 5. Full-Text Search with optional tag filtering
router.get('/search', async (req, res) => {
  try {
    const { q, tags } = req.query;
    const database = await connectDB();
    const collection = database.collection('documents');

    const query = {};
    if (q) {
      query.$text = { $search: q };
    }

    if (tags) {
      const tagsArray = tags.split(',').map(t => t.trim()).filter(Boolean);
      if (tagsArray.length > 0) {
        query.tags = { $all: tagsArray };
      }
    }

    let cursor;
    if (q) {
      cursor = collection.find(query, {
        projection: { score: { $meta: 'textScore' } }
      }).sort({ score: { $meta: 'textScore' } });
    } else {
      cursor = collection.find(query);
    }

    const results = await cursor.toArray();
    res.status(200).json(results.map(transformDocument));
  } catch (error) {
    console.error('Error performing search:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 6. Analytics: Most edited documents
router.get('/analytics/most-edited', async (req, res) => {
  try {
    const database = await connectDB();
    const collection = database.collection('documents');

    const pipeline = [
      {
        $project: {
          title: 1,
          slug: 1,
          content: 1,
          version: 1,
          tags: 1,
          metadata: 1,
          revision_history: 1,
          editCount: { $size: { $ifNull: ['$revision_history', []] } }
        }
      },
      { $sort: { editCount: -1 } },
      { $limit: 10 }
    ];

    const results = await collection.aggregate(pipeline).toArray();
    res.status(200).json(results.map(transformDocument));
  } catch (error) {
    console.error('Error getting most-edited analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 7. Analytics: Tag co-occurrence frequency
router.get('/analytics/tag-cooccurrence', async (req, res) => {
  try {
    const database = await connectDB();
    const collection = database.collection('documents');

    const pipeline = [
      // Match documents with at least 2 tags
      { $match: { 'tags.1': { $exists: true } } },
      {
        $project: {
          tagA: '$tags',
          tagB: '$tags'
        }
      },
      { $unwind: '$tagA' },
      { $unwind: '$tagB' },
      // Keep only pairs where tagA is alphabetically less than tagB to avoid duplicates and self-pairs
      { $match: { $expr: { $lt: ['$tagA', '$tagB'] } } },
      {
        $group: {
          _id: { tagA: '$tagA', tagB: '$tagB' },
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      {
        $project: {
          _id: 0,
          tags: ['$_id.tagA', '$_id.tagB'],
          count: 1
        }
      }
    ];

    const results = await collection.aggregate(pipeline).toArray();
    res.status(200).json(results);
  } catch (error) {
    console.error('Error getting tag-cooccurrence analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
