const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const path = require('path');
const dns = require('dns');
require('dotenv').config();

// Use Google DNS
dns.setServers(['8.8.8.8', '8.8.4.4']);

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const SOURCE_FOLDER = 'C:/Users/Nouman/Desktop/Asawer/BRAC/dag libra';
const CATALOG_NAME = 'Dag Libra';

// Custom sorting function
function customSort(files) {
  const group1 = []; // 147 M2
  const group2 = []; // MO DEG
  const group3 = []; // 147 (without M2)
  const group4 = []; // 164 P M2
  const group5 = []; // 164 DEG M2
  const group6 = []; // Rest

  for (const file of files) {
    const name = file.toUpperCase();
    if (name.includes('147') && name.includes('M2')) {
      group1.push(file);
    } else if (name.includes('MO DEG')) {
      group2.push(file);
    } else if (name.includes('147')) {
      group3.push(file);
    } else if (name.includes('164') && name.includes('P M2')) {
      group4.push(file);
    } else if (name.includes('164') && name.includes('DEG M2')) {
      group5.push(file);
    } else {
      group6.push(file);
    }
  }

  group1.sort(); group2.sort(); group3.sort(); group4.sort(); group5.sort(); group6.sort();
  return [...group1, ...group2, ...group3, ...group4, ...group5, ...group6];
}

async function uploadImage(filePath) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(filePath, {
      folder: 'asawer/dag-libra',
      resource_type: 'image'
    }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

async function main() {
  try {
    // Connect to MongoDB
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB\n');

    const Catalog = require('./models/Catalog');
    const Product = require('./models/Product');
    const User = require('./models/User');

    // Get admin user for createdBy field
    const adminUser = await User.findOne({ isAdmin: true });
    if (!adminUser) {
      throw new Error('No admin user found. Please create an admin user first.');
    }
    console.log(`Using admin user: ${adminUser.email}\n`);

    // Create or find catalog
    let catalog = await Catalog.findOne({ name: CATALOG_NAME });
    if (!catalog) {
      catalog = new Catalog({
        name: CATALOG_NAME,
        description: 'Dag Libra Collection',
        isPublic: true,
        ownerId: adminUser._id
      });
      await catalog.save();
      console.log(`Created catalog: ${CATALOG_NAME}\n`);
    } else {
      console.log(`Using existing catalog: ${CATALOG_NAME}\n`);
    }

    // Get all image files with custom sorting
    const allFiles = fs.readdirSync(SOURCE_FOLDER)
      .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f));

    const files = customSort(allFiles);

    console.log(`Found ${files.length} images to upload\n`);
    console.log('='.repeat(50));
    console.log('Starting upload...\n');

    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const filePath = path.join(SOURCE_FOLDER, file);
      const productName = path.basename(file, path.extname(file));
      const serialNumber = `DL-${String(i + 1).padStart(3, '0')}`;

      console.log(`[${i + 1}/${files.length}] ${productName}`);

      try {
        // Check if product already exists
        const existingProduct = await Product.findOne({
          name: productName,
          catalogId: catalog._id
        });

        if (existingProduct) {
          console.log(`   Skipped (already exists)\n`);
          successCount++;
          continue;
        }

        // Upload to Cloudinary
        const uploadResult = await uploadImage(filePath);

        // Create product
        const product = new Product({
          name: productName,
          description: `${productName} - Dag Libra Collection`,
          serialNumber: serialNumber,
          imageUrl: uploadResult.secure_url,
          price: 0,
          catalogId: catalog._id,
          createdBy: adminUser._id,
          isActive: true
        });
        await product.save();

        console.log(`   SUCCESS (${serialNumber})\n`);
        successCount++;

      } catch (error) {
        console.log(`   ERROR: ${error.message}\n`);
        errorCount++;
      }
    }

    console.log('='.repeat(50));
    console.log(`\nUpload complete!`);
    console.log(`Success: ${successCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log(`\nCatalog: ${CATALOG_NAME}`);
    console.log(`Catalog ID: ${catalog._id}`);

    await mongoose.disconnect();
    console.log('\nDone!');

  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main();
