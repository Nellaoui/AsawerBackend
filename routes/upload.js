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

    const { image, filename, mimetype, mimeType } = req.body;
    const resolvedMimeType = mimeType || mimetype || 'image/jpeg';

    if (!image || !filename) {
      console.log('Missing image data or filename');
      return res.status(400).json({ message: 'Image data and filename are required' });
    }

    // Reject a bogus MIME type here rather than letting Cloudinary fail with
    // an opaque 500. A malformed client type used to arrive as e.g.
    // "image/asawer/cache/ImagePicker/<id>" and died inside the data URI.
    // iPhone photos arrive as HEIC/HEIF; Cloudinary stores them as JPEG.
    const HEIC_MIME = ['image/heic', 'image/heif'];
    const ALLOWED_MIME = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', ...HEIC_MIME];
    if (!ALLOWED_MIME.includes(resolvedMimeType.toLowerCase())) {
      console.log('Rejected base64 upload with unsupported type:', resolvedMimeType);
      return res.status(400).json({
        message: `Unsupported image type "${resolvedMimeType}". Use JPEG, PNG, GIF, WebP or HEIC.`,
      });
    }

    // Upload to Cloudinary directly from base64
    const dataURI = `data:${resolvedMimeType};base64,${image}`;
    const result = await cloudinary.uploader.upload(dataURI, {
      folder: 'products',
      public_id: path.parse(filename).name,
      ...(HEIC_MIME.includes(resolvedMimeType.toLowerCase()) ? { format: 'jpg' } : {})
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
    // Cloudinary answers 401 when the cloud name, API key and secret don't
    // belong together. Its reason ("api_secret mismatch", "Unknown API key"...)
    // names the wrong setting and holds no secret, so pass it on.
    const reason = String(error?.message || error?.error?.message || '').split('. String to sign')[0].slice(0, 120);
    if (error?.http_code === 401 || /signature|api[ _]key|api_secret|cloud_name/i.test(reason)) {
      return res.status(502).json({ message: `The image service refused the server's Cloudinary settings (${reason || 'unauthorized'}). Check CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.` });
    }
    res.status(500).json({ message: reason ? `Error uploading image: ${reason}` : 'Error uploading image' });
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

  if (error?.message?.includes('Only image files are allowed')) {
    return res.status(400).json({ message: error.message });
  }

  console.error('Upload error:', error);
  res.status(500).json({ message: 'Error uploading file' });
});

module.exports = router;
