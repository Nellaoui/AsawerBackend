const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { auth } = require('../middlewares/auth');
const cloudinary = require('../cloudinaryConfig');

const router = express.Router();

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename with timestamp
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const extension = path.extname(file.originalname);
    cb(null, 'product-' + uniqueSuffix + extension);
  }
});

// File filter to only allow images
const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);

  if (mimetype && extname) {
    return cb(null, true);
  } else {
    cb(new Error('Only image files are allowed (jpeg, jpg, png, gif, webp)'));
  }
};

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: fileFilter
});

// POST /api/upload/image - Upload single image
router.post('/image', auth, upload.single('image'), async (req, res) => {
  try {
    console.log('Upload request received from:', req.user.email);
    console.log('Request file:', req.file ? 'File present' : 'No file');

    if (!req.file) {
      console.log('No file in request');
      return res.status(400).json({ message: 'No image file provided' });
    }

    // Upload to Cloudinary
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'products',
      public_id: path.parse(req.file.filename).name,
    });

    // Delete local file after upload
    fs.unlinkSync(req.file.path);

    console.log('Image uploaded successfully to Cloudinary:', {
      originalName: req.file.originalname,
      filename: req.file.filename,
      size: req.file.size,
      url: result.secure_url,
      uploadedBy: req.user.email
    });

    res.json({
      message: 'Image uploaded successfully',
      imageUrl: result.secure_url,
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size
    });

  } catch (error) {
    console.error('Error uploading image:', error);
    res.status(500).json({ message: 'Error uploading image' });
  }
});

// POST /api/upload/image-base64 - Upload base64 encoded image (simpler approach)
router.post('/image-base64', auth, async (req, res) => {
  try {
    console.log('Base64 upload request received from:', req.user.email);

    const { image, filename, mimetype } = req.body;

    if (!image || !filename) {
      console.log('Missing image data or filename');
      return res.status(400).json({ message: 'Image data and filename are required' });
    }

    // Upload to Cloudinary directly from base64
    const dataURI = `data:${mimetype || 'image/jpeg'};base64,${image}`;
    const result = await cloudinary.uploader.upload(dataURI, {
      folder: 'products',
      public_id: path.parse(filename).name,
    });

    console.log('Base64 image saved successfully to Cloudinary:', {
      originalName: filename,
      filename: result.public_id,
      size: Buffer.from(image, 'base64').length,
      url: result.secure_url,
      uploadedBy: req.user.email
    });

    res.json({
      message: 'Image uploaded successfully',
      imageUrl: result.secure_url,
      filename: result.public_id,
      originalName: filename,
      size: Buffer.from(image, 'base64').length
    });

  } catch (error) {
    console.error('Error uploading base64 image:', error);
    res.status(500).json({ message: 'Error uploading image' });
  }
});

// Error handling middleware for multer
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ message: 'File too large. Maximum size is 5MB.' });
    }
    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ message: 'Unexpected field name. Use "image" field.' });
    }
  }

  if (error.message.includes('Only image files are allowed')) {
    return res.status(400).json({ message: error.message });
  }

  console.error('Upload error:', error);
  res.status(500).json({ message: 'Error uploading file' });
});

module.exports = router;
