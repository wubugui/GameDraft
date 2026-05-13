import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import OpenAI from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';

// Configure environment variables
dotenv.config();

// ES Module fixes for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express app
const app = express();
const port = process.env.PORT || 8080;
const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';

// Configure multer for file uploads
const upload = multer({
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max file size
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Serve static files

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// 主流程在浏览器直连 OpenAI；此处仅在配置了密钥时初始化，避免本地无 .env 时进程退出
const openai = process.env.OPENAI_API_KEY?.trim()
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// Routes
app.post('/api/generate-sprite', upload.single('image'), async (req, res) => {
  try {
    if (!openai) {
      res.status(503).json({ error: 'Server-side OpenAI is not configured (set OPENAI_API_KEY).' });
      return;
    }
    // This endpoint will be implemented later
    res.json({ message: 'Sprite generation endpoint (to be implemented)' });
  } catch (error) {
    console.error('Error generating sprite:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(port, host, () => {
  console.log(`Server running at http://${host}:${port}`);
  console.log('Press Ctrl+C to stop');
}); 