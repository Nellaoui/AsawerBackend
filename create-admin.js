const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

// User schema
const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true
  },
  name: {
    type: String,
    required: true
  },
  isAdmin: {
    type: Boolean,
    default: false
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user'
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Sync role field with isAdmin field
userSchema.pre('save', function(next) {
  if (this.isAdmin) {
    this.role = 'admin';
  } else {
    this.role = 'user';
  }
  next();
});

const User = mongoose.model('User', userSchema);

async function createAdminUser() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // Check if admin user already exists
    const existingAdmin = await User.findOne({ email: 'admin@asawer.com' });
    if (existingAdmin) {
      console.log('Admin user already exists:', existingAdmin.email);
      return;
    }

    // Create admin user
    const adminUser = new User({
      email: 'admin@asawer.com',
      password: 'admin123',
      name: 'Asawer Admin',
      isAdmin: true
    });

    await adminUser.save();
    console.log('Admin user created successfully:', adminUser.email);

    // Also create test users
    const testUsers = [
      {
        email: 'admin@test.com',
        password: 'test123',
        name: 'Test Admin',
        isAdmin: true
      },
      {
        email: 'user@test.com',
        password: 'test123',
        name: 'Test User',
        isAdmin: false
      }
    ];

    for (const userData of testUsers) {
      const existingUser = await User.findOne({ email: userData.email });
      if (!existingUser) {
        const user = new User(userData);
        await user.save();
        console.log('Test user created:', userData.email);
      } else {
        console.log('Test user already exists:', userData.email);
      }
    }

    console.log('Database initialization completed!');
  } catch (error) {
    console.error('Error creating admin user:', error);
  } finally {
    await mongoose.connection.close();
    console.log('Database connection closed');
  }
}

createAdminUser();
