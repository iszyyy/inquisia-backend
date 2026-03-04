import multer from 'multer'
import path from 'path'
import { randomUUID } from 'crypto'
import dotenv from 'dotenv'
dotenv.config()

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/opt/inquisia-backend/uploads'
const MAX_SIZE_MB = 50

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    cb(null, `${randomUUID()}${ext}`)
  },
})

function pdfFilter(_req, file, cb) {
  if (file.mimetype === 'application/pdf') {
    cb(null, true)
  } else {
    cb(new Error('Only PDF files are accepted.'), false)
  }
}

export const uploadPdf = multer({
  storage,
  fileFilter: pdfFilter,
  limits: { fileSize: MAX_SIZE_MB * 1024 * 1024 },
})
