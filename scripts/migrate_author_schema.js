const { MongoClient } = require('mongodb');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DATABASE_NAME = process.env.DATABASE_NAME || 'collaborative_store';
const BATCH_SIZE = 1000;

async function runMigration() {
  console.log('--- Starting Background Schema Migration ---');
  console.log(`Connecting to: ${MONGO_URI}`);
  console.log(`Database: ${DATABASE_NAME}`);

  let client;
  try {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    const db = client.db(DATABASE_NAME);
    const collection = db.collection('documents');

    // 1. Identify documents using the old author schema (type: string)
    const query = { 'metadata.author': { $type: 'string' } };
    const totalCount = await collection.countDocuments(query);
    console.log(`Found ${totalCount} documents with the old string-based author schema.`);

    if (totalCount === 0) {
      console.log('No documents require migration. Schema is fully up-to-date.');
      return;
    }

    let migratedCount = 0;

    // 2. Iterate and process in batches of 1000 to avoid memory overflow
    while (true) {
      // Find the next batch of documents that match the old schema
      const batchDocs = await collection
        .find(query)
        .limit(BATCH_SIZE)
        .toArray();

      if (batchDocs.length === 0) {
        break;
      }

      console.log(`Processing batch of ${batchDocs.length} documents...`);

      // 3. Construct bulkWrite operations for atomic updates in a single network round-trip
      const bulkOps = batchDocs.map(doc => {
        const oldAuthorString = doc.metadata.author;
        return {
          updateOne: {
            filter: { _id: doc._id },
            update: {
              $set: {
                'metadata.author': {
                  id: null,
                  name: oldAuthorString,
                  email: null
                }
              }
            }
          }
        };
      });

      // 4. Perform bulk write operation
      const result = await collection.bulkWrite(bulkOps);
      migratedCount += result.modifiedCount;

      console.log(`Batch execution finished. Progress: ${migratedCount} / ${totalCount} documents migrated.`);
    }

    console.log(`--- Migration successfully completed! Total documents migrated: ${migratedCount} ---`);
  } catch (error) {
    console.error('Migration failed with exception:', error);
    process.exit(1);
  } finally {
    if (client) {
      await client.close();
      console.log('Database connection closed.');
    }
  }
}

// Execute migration
runMigration();
