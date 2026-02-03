const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const admin = require('firebase-admin');
const { Readable } = require('stream');
const path = require('path'); // Этот модуль нужен для работы с расширениями

const app = express();

// --- CORS ---
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// --- 1. Подключение Firebase ---
let db;
let ref;

try {
    let rawJson = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (rawJson.startsWith('"') && rawJson.endsWith('"')) {
        rawJson = rawJson.slice(1, -1);
    }
    const serviceAccount = JSON.parse(rawJson);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DB_URL
    });

    db = admin.database();
    ref = db.ref("materials");
    console.log("Firebase подключен успешно!");

} catch (error) {
    console.error("!!! ОШИБКА FIREBASE !!! Проверь JSON.");
}

// --- 2. Подключение Cloudinary ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_KEY,
  api_secret: process.env.CLOUDINARY_SECRET
});

// Лимит 50 МБ
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } 
});

// --- Авторизация ---
const ADMIN_LOGIN = "Gaponenko";
const ADMIN_PASS = "GaponenkoJ";

const checkAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(403).json({ error: "Нет доступа" });
  const [login, pass] = authHeader.split(':');
  if (login === ADMIN_LOGIN && pass === ADMIN_PASS) next();
  else res.status(403).json({ error: "Неверный логин" });
};

// --- МАРШРУТЫ ---

app.get('/ping', (req, res) => res.send('Pong! Server is alive.'));
app.get('/', (req, res) => res.send('Backend is working!'));

// 1. Получить
app.get('/api/materials', async (req, res) => {
  if (!ref) return res.status(500).json({ error: "Ошибка БД" });
  try {
    const snapshot = await ref.once('value');
    res.json(snapshot.val() || {});
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Загрузить (ИСПРАВЛЕНО ДЛЯ ФАЙЛОВ)
app.post('/api/upload', checkAuth, upload.single('file'), async (req, res) => {
  if (!ref) return res.status(500).json({ error: "БД не подключена" });
  try {
    const { title, category, textContent, isTextPost } = req.body;
    const newFileRef = ref.push();
    
    let fileData = {
      id: newFileRef.key,
      title: title,
      category: category,
      createdAt: Date.now()
    };

    if (isTextPost === 'true') {
        fileData.type = 'text';
        fileData.content = textContent;
        fileData.url = null;
    } else {
        if (!req.file) return res.status(400).send('Нет файла');

        // --- ЛЕЧИМ ИМЕНА ФАЙЛОВ ---
        // 1. Исправляем русские буквы (Multer часто бьет кодировку)
        let originalName = req.file.originalname;
        try {
            originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
        } catch(e) {}

        // 2. Получаем чистое расширение (например .pptx)
        const ext = path.extname(originalName); 
        
        // 3. Генерируем уникальное имя, но ОБЯЗАТЕЛЬНО с расширением в конце
        // Cloudinary любит, когда имя чистое, поэтому убираем пробелы
        const safeName = Date.now() + '_' + originalName.replace(/[^a-zA-Z0-9а-яА-ЯёЁ\.\-_]/g, '_');

        const streamUpload = (fileBuffer) => {
            return new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    { 
                        resource_type: "auto", 
                        folder: "primizht_history",
                        public_id: safeName, // Принудительно задаем имя
                        use_filename: true,   // Просим использовать это имя
                        unique_filename: false // Не добавлять лишний мусор к имени
                    },
                    (error, result) => { if (result) resolve(result); else reject(error); }
                );
                Readable.from(fileBuffer).pipe(stream);
            });
        };

        const result = await streamUpload(req.file.buffer);
        
        fileData.type = result.format || ext.replace('.', '') || 'file'; // Если формат не определился, берем из имени
        fileData.url = result.secure_url;
        fileData.public_id = result.public_id;
    }

    await newFileRef.set(fileData);
    res.json(fileData);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка загрузки" });
  }
});

// 3. Редактировать
app.put('/api/edit/:id', checkAuth, async (req, res) => {
    if (!ref) return res.status(500).json({ error: "БД не подключена" });
    try {
        const { id } = req.params;
        const { title, category, content } = req.body;
        const itemRef = ref.child(id);
        const snapshot = await itemRef.once('value');
        if (!snapshot.exists()) return res.status(404).json({ error: "Не найдено" });
        
        const updates = { title, category };
        if (content) updates.content = content;
        await itemRef.update(updates);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. Удалить
app.delete('/api/delete/:id', checkAuth, async (req, res) => {
    if (!ref) return res.status(500).json({ error: "БД не подключена" });
    try {
        const fileId = req.params.id;
        const itemRef = ref.child(fileId);
        const snapshot = await itemRef.once('value');
        const item = snapshot.val();

        if (item && item.public_id) {
            try {
                let resourceType = 'image';
                const type = item.type ? item.type.toLowerCase() : '';
                // RAW - для документов, VIDEO - для видео
                if (type === 'pdf' || type.includes('doc') || type.includes('ppt') || type.includes('xls') || type === 'zip' || type === 'rar') {
                    resourceType = 'raw'; 
                } else if (type === 'mp4' || type === 'avi' || type === 'mov') {
                    resourceType = 'video';
                }
                
                await cloudinary.uploader.destroy(item.public_id, { resource_type: resourceType });
            } catch (e) { console.error("Cloudinary delete error:", e); }
        }
        await itemRef.remove();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
