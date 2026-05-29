const { MongoClient } = require('mongodb');
const { execSync } = require('child_process');
const path = require('path');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DATABASE_NAME = process.env.DATABASE_NAME || 'collaborative_store';
const API_URL = 'http://localhost:3000/api';

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('==================================================');
  console.log('        COLLABORATIVE STORE - INTEGRATION TESTS   ');
  console.log('==================================================\n');

  let client;
  try {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    const db = client.db(DATABASE_NAME);
    const collection = db.collection('documents');

    // --- REQUIREMENT 1 & 2: Seed Verification & Indexes ---
    console.log('Testing Core Requirement 1 & 2: Database Seeding & Indexes...');
    
    // Check total seeded count (should be at least 1,000, we did 10,000!)
    const seededCount = await collection.countDocuments();
    console.log(`- Seeded documents in collection: ${seededCount}`);
    if (seededCount < 1000) {
      throw new Error(`Seeding failed. Expected at least 1,000 documents, found: ${seededCount}`);
    }
    console.log('  [PASS] Seed count is correct.');

    // Check indexes
    const indexes = await collection.indexes();
    const indexNames = indexes.map(idx => idx.name);
    console.log(`- Active Indexes:`, indexNames);
    
    const hasSlugIndex = indexes.some(idx => idx.key.slug === 1 && idx.unique);
    const hasTextIndex = indexes.some(idx => idx.key._fts === 'text');
    
    if (!hasSlugIndex) {
      throw new Error('Unique index on "slug" not found.');
    }
    console.log('  [PASS] Unique index on slug exists.');
    
    if (!hasTextIndex) {
      throw new Error('Text index on "title" and "content" not found.');
    }
    console.log('  [PASS] Text index on title and content exists.');

    // Verify sample document structure
    const sampleDoc = await collection.findOne();
    const requiredKeys = ['slug', 'title', 'content', 'version', 'tags', 'metadata', 'revision_history'];
    for (const key of requiredKeys) {
      if (sampleDoc[key] === undefined) {
        throw new Error(`Sample document is missing required field: ${key}`);
      }
    }
    if (!sampleDoc.metadata.createdAt || !sampleDoc.metadata.updatedAt) {
      throw new Error('Sample document metadata is missing timestamp fields.');
    }
    if (!Array.isArray(sampleDoc.revision_history)) {
      throw new Error('Sample document revision_history is not an array.');
    }
    console.log('  [PASS] Document schema is verified.');

    // --- REQUIREMENT 3: POST /api/documents ---
    console.log('\nTesting Core Requirement 3: POST /api/documents...');
    const testDocPayload = {
      title: 'Automated Testing with MongoDB',
      content: 'This is a brand new page written specifically to verify the POST /api/documents route works. It covers concurrency and search pipelines.',
      tags: ['testing', 'mongodb', 'concurrency'],
      authorName: 'Test Suite Bot',
      authorEmail: 'bot@test.com'
    };

    const postResponse = await fetch(`${API_URL}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testDocPayload)
    });

    if (postResponse.status !== 201) {
      throw new Error(`POST /api/documents failed with status: ${postResponse.status}`);
    }
    
    const createdDoc = await postResponse.json();
    console.log(`- Created Document Slug: ${createdDoc.slug}`);
    console.log(`- Created Document Version: ${createdDoc.version}`);
    
    if (createdDoc.version !== 1) {
      throw new Error(`Expected initial version to be 1, got: ${createdDoc.version}`);
    }
    if (createdDoc.metadata.author.name !== testDocPayload.authorName) {
      throw new Error('Created document authorName does not match.');
    }
    
    // Check if inserted in DB
    const dbCheckedDoc = await collection.findOne({ slug: createdDoc.slug });
    if (!dbCheckedDoc) {
      throw new Error('Document was not successfully saved in the database.');
    }
    console.log('  [PASS] POST /api/documents verified.');

    // --- REQUIREMENT 4 & 12: GET /api/documents/:slug & Transparent upgrade ---
    console.log('\nTesting Core Requirement 4 & 12: GET /api/documents/:slug & Lazy Schema Upgrade...');
    
    // Insert an old author schema document directly into the database
    const oldSlug = `old-schema-doc-${Date.now()}`;
    await collection.insertOne({
      slug: oldSlug,
      title: 'Old Schema Document',
      content: 'This document uses the deprecated author schema where author is a simple string.',
      version: 1,
      tags: ['legacy', 'migration'],
      metadata: {
        author: 'Old Legacy Author', // string instead of object
        createdAt: new Date(),
        updatedAt: new Date(),
        wordCount: 10
      },
      revision_history: []
    });

    // Request it via GET to verify transparent upgrade
    const getResponse = await fetch(`${API_URL}/documents/${oldSlug}`);
    if (getResponse.status !== 200) {
      throw new Error(`GET /api/documents/:slug for old schema failed: ${getResponse.status}`);
    }
    
    const upgradedResponseDoc = await getResponse.json();
    console.log('- Raw DB schema has author as: String ("Old Legacy Author")');
    console.log('- Upgraded GET Response author: ', upgradedResponseDoc.metadata.author);
    
    if (typeof upgradedResponseDoc.metadata.author !== 'object' || upgradedResponseDoc.metadata.author === null) {
      throw new Error('Old author schema was not upgraded to an object in response.');
    }
    if (upgradedResponseDoc.metadata.author.name !== 'Old Legacy Author') {
      throw new Error('Upgraded author name does not match original.');
    }
    if (upgradedResponseDoc.metadata.author.id !== null || upgradedResponseDoc.metadata.author.email !== null) {
      throw new Error('Upgraded author id and email should be null.');
    }
    console.log('  [PASS] Transparent read-time upgrade is verified.');

    // Verify 404 response
    const get404Response = await fetch(`${API_URL}/documents/non-existent-slug-xyz`);
    if (get404Response.status !== 404) {
      throw new Error(`Expected 404 for non-existent slug, got: ${get404Response.status}`);
    }
    console.log('  [PASS] GET for non-existent slug returns 404.');

    // --- REQUIREMENT 5: PUT /api/documents/:slug (Successful OCC) ---
    console.log('\nTesting Core Requirement 5: PUT /api/documents/:slug (Successful OCC)...');
    
    const activeSlug = createdDoc.slug; // version: 1
    const putPayload = {
      title: 'Automated Testing with MongoDB (Updated)',
      content: 'This is the newly modified content of the test page.',
      version: 1 // correct version
    };

    const putResponse = await fetch(`${API_URL}/documents/${activeSlug}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(putPayload)
    });

    if (putResponse.status !== 200) {
      throw new Error(`PUT /api/documents failed with status: ${putResponse.status}`);
    }

    const updatedDocRes = await putResponse.json();
    console.log(`- Updated Version in Response: ${updatedDocRes.version}`);
    if (updatedDocRes.version !== 2) {
      throw new Error(`Expected incremented version: 2, got: ${updatedDocRes.version}`);
    }
    if (updatedDocRes.content !== putPayload.content) {
      throw new Error('Content update was not applied.');
    }
    
    // Check revision_history has a new entry for version 2
    console.log(`- Revision history entries: ${updatedDocRes.revision_history.length}`);
    const lastRev = updatedDocRes.revision_history.find(rev => rev.version === 2);
    if (!lastRev) {
      throw new Error('Revision history is missing an entry for version 2.');
    }
    console.log('  [PASS] Successful OCC update verified.');

    // --- REQUIREMENT 6: PUT /api/documents/:slug (OCC Conflict 409) ---
    console.log('\nTesting Core Requirement 6: PUT /api/documents/:slug (OCC Conflict 409)...');
    
    const conflictPayload = {
      title: 'Conflict Hack',
      content: 'This update is trying to write with an outdated version.',
      version: 1 // Outdated! The current version in database is 2
    };

    const conflictResponse = await fetch(`${API_URL}/documents/${activeSlug}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(conflictPayload)
    });

    console.log(`- Conflict Response Status: ${conflictResponse.status}`);
    if (conflictResponse.status !== 409) {
      throw new Error(`Expected 409 Conflict, got: ${conflictResponse.status}`);
    }

    const conflictData = await conflictResponse.json();
    console.log(`- Conflict Response body contains latest version: ${conflictData.version}`);
    if (conflictData.version !== 2) {
      throw new Error(`Expected conflict response to contain latest database version 2, got: ${conflictData.version}`);
    }

    // Verify database was NOT modified
    const dbUnmodifiedDoc = await collection.findOne({ slug: activeSlug });
    if (dbUnmodifiedDoc.version !== 2 || dbUnmodifiedDoc.title === conflictPayload.title) {
      throw new Error('Database document was modified despite OCC version conflict.');
    }
    console.log('  [PASS] Conflict OCC update correctly rejected and returns 409 with latest document.');

    // --- REQUIREMENT 7 & 8: Search with relevance & tags ---
    console.log('\nTesting Core Requirement 7 & 8: Full-Text Search & Tag Filtering...');
    
    // Insert unique searchable pages
    const uniqueTerm = `cybersearch${Date.now()}`;
    await collection.insertMany([
      {
        slug: `search-doc-1-${Date.now()}`,
        title: `${uniqueTerm} Mongo Engine`,
        content: `Detailed specifications for the query database system.`,
        version: 1,
        tags: ['nosql', 'fast'],
        metadata: { author: 'A', createdAt: new Date(), updatedAt: new Date(), wordCount: 5 },
        revision_history: []
      },
      {
        slug: `search-doc-2-${Date.now()}`,
        title: `Standard API Tutorial`,
        content: `Explaining the web backend using ${uniqueTerm} with extra keyword query.`,
        version: 1,
        tags: ['nosql', 'api'],
        metadata: { author: 'B', createdAt: new Date(), updatedAt: new Date(), wordCount: 5 },
        revision_history: []
      }
    ]);

    // Let text indexes catch up (in MongoDB local they are synchronous but wait a split second anyway)
    await wait(300);

    // 1. Check full-text search relevance sorting
    const searchResponse = await fetch(`${API_URL}/search?q=${uniqueTerm}`);
    if (searchResponse.status !== 200) {
      throw new Error(`Search GET failed: ${searchResponse.status}`);
    }
    const searchResults = await searchResponse.json();
    console.log(`- Search results found: ${searchResults.length}`);
    if (searchResults.length !== 2) {
      throw new Error(`Expected 2 search results, found: ${searchResults.length}`);
    }

    // Check score exists and is sorted in descending order
    console.log(`- First document score: ${searchResults[0].score}`);
    console.log(`- Second document score: ${searchResults[1].score}`);
    
    if (searchResults[0].score === undefined || searchResults[1].score === undefined) {
      throw new Error('Search results do not include "score" field with $meta textScore.');
    }
    if (searchResults[0].score < searchResults[1].score) {
      throw new Error('Search results are not sorted in descending order of relevance score.');
    }
    console.log('  [PASS] Full-Text search and textScore sorting verified.');

    // 2. Check tag filtering with text query
    const tagSearchResponse = await fetch(`${API_URL}/search?q=${uniqueTerm}&tags=nosql,api`);
    if (tagSearchResponse.status !== 200) {
      throw new Error(`Search with tags failed: ${tagSearchResponse.status}`);
    }
    const tagSearchResults = await tagSearchResponse.json();
    console.log(`- Tagged search results found: ${tagSearchResults.length}`);
    if (tagSearchResults.length !== 1) {
      throw new Error(`Expected exactly 1 result matching BOTH text query and tags [nosql, api], found: ${tagSearchResults.length}`);
    }
    if (tagSearchResults[0].slug.indexOf('search-doc-2-') === -1) {
      throw new Error('Incorrect document returned in search with tag filter.');
    }
    console.log('  [PASS] Combined Full-Text search and Tag filtering verified.');

    // --- REQUIREMENT 9: Analytics Most Edited ---
    console.log('\nTesting Core Requirement 9: Analytics /api/analytics/most-edited...');
    const mostEditedResponse = await fetch(`${API_URL}/analytics/most-edited`);
    if (mostEditedResponse.status !== 200) {
      throw new Error(`GET most-edited failed: ${mostEditedResponse.status}`);
    }
    const mostEditedResults = await mostEditedResponse.json();
    console.log(`- Results returned: ${mostEditedResults.length}`);
    if (mostEditedResults.length === 0) {
      throw new Error('Expected analytics to return list of documents.');
    }
    
    // Verify sorting by length of revision_history
    const lengths = mostEditedResults.map(doc => doc.revision_history.length);
    console.log('- Revision history lengths in top results:', lengths);
    for (let i = 0; i < lengths.length - 1; i++) {
      if (lengths[i] < lengths[i + 1]) {
        throw new Error('Most edited analytics are not sorted by revision history length in descending order.');
      }
    }
    console.log('  [PASS] Analytics /api/analytics/most-edited verified.');

    // --- REQUIREMENT 10: Analytics Tag Co-occurrence ---
    console.log('\nTesting Core Requirement 10: Analytics /api/analytics/tag-cooccurrence...');
    const coocResponse = await fetch(`${API_URL}/analytics/tag-cooccurrence`);
    if (coocResponse.status !== 200) {
      throw new Error(`GET tag-cooccurrence failed: ${coocResponse.status}`);
    }
    const coocResults = await coocResponse.json();
    console.log(`- Total tag co-occurrence pairs: ${coocResults.length}`);
    if (coocResults.length === 0) {
      throw new Error('Expected co-occurrence pairs to be returned.');
    }
    
    console.log('- Sample co-occurrence item:', coocResults[0]);
    if (!Array.isArray(coocResults[0].tags) || coocResults[0].tags.length !== 2) {
      throw new Error('Co-occurrence response items must contain a "tags" array of length 2.');
    }
    if (coocResults[0].count === undefined) {
      throw new Error('Co-occurrence response items must contain a "count" field.');
    }
    
    // Check count sorting descending
    const counts = coocResults.map(item => item.count);
    for (let i = 0; i < counts.length - 1; i++) {
      if (counts[i] < counts[i + 1]) {
        throw new Error('Tag co-occurrence list is not sorted by count in descending order.');
      }
    }
    console.log('  [PASS] Analytics /api/analytics/tag-cooccurrence verified.');

    // --- REQUIREMENT 11: Background Schema Migration ---
    console.log('\nTesting Core Requirement 11: Background Migration Script...');
    
    // Seed 3 more legacy schema documents directly in DB
    const migrationSlugs = [`mig-doc-1-${Date.now()}`, `mig-doc-2-${Date.now()}`, `mig-doc-3-${Date.now()}`];
    await collection.insertMany(migrationSlugs.map((s, idx) => ({
      slug: s,
      title: `Migration Document ${idx}`,
      content: `Content for migration ${idx}`,
      version: 1,
      tags: ['migration-test'],
      metadata: {
        author: `Legacy Author Name ${idx}`, // string format
        createdAt: new Date(),
        updatedAt: new Date(),
        wordCount: 3
      },
      revision_history: []
    })));

    // Execute background migration script via child process
    console.log('Executing node scripts/migrate_author_schema.js...');
    const migrationScriptPath = path.join(__dirname, 'migrate_author_schema.js');
    const stdout = execSync(`node "${migrationScriptPath}"`, { encoding: 'utf-8' });
    console.log('Migration Script Output:\n', stdout);

    // Verify in database that the newly inserted legacy documents have been updated
    const migratedDocs = await collection.find({ slug: { $in: migrationSlugs } }).toArray();
    for (let i = 0; i < migratedDocs.length; i++) {
      const doc = migratedDocs[i];
      console.log(`- Document "${doc.slug}" author schema in DB:`, doc.metadata.author);
      if (typeof doc.metadata.author !== 'object' || doc.metadata.author === null) {
        throw new Error(`Document ${doc.slug} was not migrated in the database! Still has string type.`);
      }
      if (doc.metadata.author.name !== `Legacy Author Name ${i}`) {
        throw new Error(`Migrated author name is incorrect for ${doc.slug}`);
      }
      if (doc.metadata.author.id !== null || doc.metadata.author.email !== null) {
        throw new Error(`Migrated author ID or email should be null for ${doc.slug}`);
      }
    }
    console.log('  [PASS] Background migration script executed successfully and database is fully upgraded!');

    console.log('\n==================================================');
    console.log('  ALL INTEGRATION TESTS PASSED SUCCESSFULLY!  ');
    console.log('==================================================');
  } catch (error) {
    console.error('\n[FAIL] Test verification failed:', error);
    process.exit(1);
  } finally {
    if (client) {
      try {
        const db = client.db(DATABASE_NAME);
        const collection = db.collection('documents');
        const cleanResult = await collection.deleteMany({
          slug: { $regex: 'search-doc-|automated-testing-|old-schema-doc-|mig-doc-' }
        });
        console.log(`- Cleaned up ${cleanResult.deletedCount} integration test records.`);
      } catch (err) {
        // ignore
      }
      await client.close();
    }
  }
}

// Run the suite
runTests();
