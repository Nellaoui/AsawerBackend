const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

// Import models
const User = require('./models/User');
const Product = require('./models/Product');
const Catalog = require('./models/Catalog');
const Order = require('./models/Order');

async function initializeDatabase() {
  try {
    console.log('Connecting to MongoDB...');
    console.log('MongoDB URI:', process.env.MONGODB_URI || 'mongodb://localhost:27017/jewelry-app');
    
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/jewelry-app', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
    });
    console.log('✅ Connected to MongoDB');

    // Clear existing data (optional - remove if you want to keep existing data)
    console.log('Clearing existing data...');
    await User.deleteMany({});
    await Product.deleteMany({});
    await Catalog.deleteMany({});
    await Order.deleteMany({});
    console.log('✅ Cleared existing data');

    // Create indexes
    console.log('Creating indexes...');
    await User.collection.createIndex({ email: 1 }, { unique: true });
    await Product.collection.createIndex({ name: 1 });
    await Product.collection.createIndex({ serialNumber: 1 }, { unique: true });
    await Catalog.collection.createIndex({ name: 1 });
    await Catalog.collection.createIndex({ ownerId: 1 });
    await Order.collection.createIndex({ userId: 1 });
    await Order.collection.createIndex({ catalogId: 1 });
    await Order.collection.createIndex({ status: 1 });
    console.log('✅ Created indexes');

    // Create admin users
    console.log('Creating admin users...');
    const adminPassword = await bcrypt.hash('admin123', 10);
    const testPassword = await bcrypt.hash('test123', 10);

    const users = await User.insertMany([
      {
        email: 'admin@asawer.com',
        password: adminPassword,
        name: 'Admin User',
        isAdmin: true,
        role: 'admin',
        isActive: true,
        createdAt: new Date()
      },
      {
        email: 'admin@test.com',
        password: testPassword,
        name: 'Test Admin',
        isAdmin: true,
        role: 'admin',
        isActive: true,
        createdAt: new Date()
      },
      {
        email: 'user@test.com',
        password: testPassword,
        name: 'Test User',
        isAdmin: false,
        role: 'user',
        isActive: true,
        createdAt: new Date()
      }
    ]);
    console.log('✅ Created admin users');

    // Create sample catalog
    console.log('Creating sample catalog...');
    const sampleCatalog = await Catalog.create({
      name: 'Sample Jewelry Collection',
      description: 'A sample collection of jewelry items',
      ownerId: users[0]._id,
      isActive: true,
      createdAt: new Date()
    });
    console.log('✅ Created sample catalog');

    // Create sample products
    console.log('Creating sample products...');
    await Product.insertMany([
      {
        name: 'Gold Ring',
        description: 'Beautiful 18k gold ring',
        price: 299.99,
        serialNumber: 'GR001',
        type: 'Rings',
        catalogId: sampleCatalog._id,
        createdBy: users[0]._id,
        isActive: true,
        createdAt: new Date()
      },
      {
        name: 'Diamond Necklace',
        description: 'Elegant diamond necklace',
        price: 1299.99,
        serialNumber: 'DN001',
        type: 'Necklaces',
        catalogId: sampleCatalog._id,
        createdBy: users[0]._id,
        isActive: true,
        createdAt: new Date()
      },
      {
        name: 'Silver Bracelet',
        description: 'Stylish silver bracelet',
        price: 149.99,
        serialNumber: 'SB001',
        type: 'Bracelets',
        catalogId: sampleCatalog._id,
        createdBy: users[0]._id,
        isActive: true,
        createdAt: new Date()
      }
    ]);
    console.log('✅ Created sample products');

    console.log('\n🎉 Database initialization completed successfully!');
    console.log('\n📋 Created accounts:');
    console.log('👤 Admin: admin@asawer.com (password: admin123)');
    console.log('👤 Test Admin: admin@test.com (password: test123)');
    console.log('👤 Test User: user@test.com (password: test123)');
    console.log('\n📦 Created sample catalog with 3 products');
    
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
    process.exit(0);
  }
}

// Run initialization
initializeDatabase();
