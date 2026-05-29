const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DATABASE_NAME = process.env.DATABASE_NAME || 'collaborative_store';

let db = null;
let client = null;

async function connectDB() {
  if (db) return db;
  try {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(DATABASE_NAME);
    console.log(`Connected to MongoDB database: ${DATABASE_NAME}`);
    return db;
  } catch (error) {
    console.error('Failed to connect to MongoDB', error);
    throw error;
  }
}

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')           // Replace spaces with -
    .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
    .replace(/\-\-+/g, '-')         // Replace multiple - with single -
    .replace(/^-+/, '')             // Trim - from start
    .replace(/-+$/, '');            // Trim - from end
}

// Generates a mock Wikipedia export XML string to simulate download & parsing
function generateWikipediaXML(count) {
  console.log(`Generating mock Wikipedia XML stub with ${count} articles...`);
  let xml = '<mediawiki xmlns="http://www.mediawiki.org/xml/export-0.10/">\n';
  
  const subjects = ['MongoDB', 'API Design', 'Express', 'NodeJS', 'Database', 'Scaling', 'Docker', 'Concurrency', 'Search', 'Analytics'];
  const tagsList = ['guide', 'tutorial', 'nosql', 'backend', 'performance', 'advanced', 'programming', 'architecture', 'web', 'system'];

  for (let i = 1; i <= count; i++) {
    const subject = subjects[i % subjects.length];
    const title = `${subject} Deep Dive Part ${i}`;
    const author = `Author ${i}`;
    
    // Pick 2-3 random tags
    const pickedTags = [];
    pickedTags.push(subject.toLowerCase());
    pickedTags.push(tagsList[(i * 3) % tagsList.length]);
    pickedTags.push(tagsList[(i * 7) % tagsList.length]);
    const uniqueTags = [...new Set(pickedTags)];

    const text = `This is a comprehensive article about ${subject}. In this part ${i}, we explore advanced details of building scalable architectures. Under high-load conditions, systems using ${subject} show remarkable capabilities. Optimistic Concurrency Control (OCC) and text indexes are critical. Learning about ${uniqueTags.join(' and ')} is highly recommended for developers.`;

    xml += `  <page>\n`;
    xml += `    <title>${title}</title>\n`;
    xml += `    <author>${author}</author>\n`;
    xml += `    <tags>${uniqueTags.join(',')}</tags>\n`;
    xml += `    <text xml:space="preserve">${text}</text>\n`;
    xml += `  </page>\n`;
  }
  
  xml += '</mediawiki>\n';
  return xml;
}

async function seedDatabase() {
  const database = await connectDB();
  const collection = database.collection('documents');

  // Check if documents collection is empty
  const count = await collection.countDocuments();
  if (count > 0) {
    console.log(`Database already contains ${count} documents. Skipping seeding.`);
    
    // Make sure indexes exist even if already seeded
    console.log('Ensuring indexes exist...');
    await collection.createIndex({ slug: 1 }, { unique: true });
    await collection.createIndex({ title: 'text', content: 'text' });
    console.log('Indexes verified.');
    return;
  }

  console.log('Database is empty. Starting seeding process...');

  // 1. Generate XML stub locally (satisfying "download a small subset ... (a stub is fine)")
  const xmlContent = generateWikipediaXML(10000);
  const stubPath = path.join(__dirname, 'wikipedia_stub.xml');
  fs.writeFileSync(stubPath, xmlContent, 'utf-8');
  console.log(`XML stub saved to ${stubPath}`);

  // 2. Parse XML
  console.log('Parsing XML stub...');
  const parsedDocuments = [];
  const pages = xmlContent.split('<page>');
  
  const now = new Date();

  // The first element is the mediawiki header, we skip it
  for (let i = 1; i < pages.length; i++) {
    const pageMarkup = pages[i];
    const title = pageMarkup.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '';
    const text = pageMarkup.match(/<text[\s\S]*?>([\s\S]*?)<\/text>/)?.[1] || '';
    const authorName = pageMarkup.match(/<author>([\s\S]*?)<\/author>/)?.[1] || '';
    const tagsStr = pageMarkup.match(/<tags>([\s\S]*?)<\/tags>/)?.[1] || '';
    const tags = tagsStr ? tagsStr.split(',') : [];

    const slug = slugify(title);

    // Conforming to the requirements:
    // For ~10% of documents, intentionally use the old author schema ("author": "string")
    const isOldSchema = i % 10 === 0;
    
    let authorField;
    if (isOldSchema) {
      authorField = authorName; // Old schema: string
    } else {
      authorField = {
        id: `user-${i}`,
        name: authorName,
        email: `author${i}@example.com`
      };
    }

    // Vary the revision history to support the analytics requirement of testing "most-edited"
    // The top edited documents will have revision_history lengths from 1 to 15
    const revisionCount = i <= 15 ? i : 1; 
    const revision_history = [];
    for (let r = 1; r <= revisionCount; r++) {
      revision_history.push({
        version: r,
        updatedAt: new Date(now.getTime() - (revisionCount - r) * 3600000), // dynamic times
        authorId: `user-${i}`,
        contentDiff: `Revision ${r} content modifications.`
      });
    }

    const doc = {
      slug,
      title,
      content: text,
      version: revisionCount,
      tags,
      metadata: {
        author: authorField,
        createdAt: new Date(now.getTime() - 86400000), // created 1 day ago
        updatedAt: now,
        wordCount: text.split(/\s+/).filter(Boolean).length
      },
      revision_history
    };

    parsedDocuments.push(doc);
  }

  console.log(`Parsed ${parsedDocuments.length} documents. Inserting into database in batches...`);

  // Insert in batches of 1000 to keep memory footprint light
  const batchSize = 1000;
  for (let j = 0; j < parsedDocuments.length; j += batchSize) {
    const batch = parsedDocuments.slice(j, j + batchSize);
    await collection.insertMany(batch);
    console.log(`Inserted documents ${j + 1} to ${Math.min(j + batchSize, parsedDocuments.length)}`);
  }

  // 3. Create indexes
  console.log('Creating unique index on slug field...');
  await collection.createIndex({ slug: 1 }, { unique: true });

  console.log('Creating full-text index on title and content fields...');
  await collection.createIndex({ title: 'text', content: 'text' });

  console.log('Seeding completed successfully!');
  
  // Clean up the XML file
  try {
    fs.unlinkSync(stubPath);
  } catch (err) {
    // ignore
  }
}

module.exports = {
  connectDB,
  seedDatabase,
  slugify
};
