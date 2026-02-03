const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const admin = require('firebase-admin');
const { Readable } = require('stream');

const app = express();
app.use(cors());
app.use(express.json());

// --- 1. Настройки (Firebase & Cloudinary) ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL
});

const db = admin.database();
const ref = db.ref("materials");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_KEY,
  api_secret: process.env.CLOUDINARY_SECRET
});

// Настройка загрузки (лимит 50МБ для защиты памяти)
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } 
});

// --- 2. Авторизация ---
const ADMIN_LOGIN = "Gaponenko";
const ADMIN_PASS = "GaponenkoJ";

const checkAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(403).json({ error: "Нет доступа" });
  
  const [login, pass] = authHeader.split(':');
  if (login === ADMIN_LOGIN && pass === ADMIN_PASS) {
    next();
  } else {
    res.status(403).json({ error: "Неверный логин или пароль" });
  }
};

// --- API МАРШРУТЫ ---

// 0. Пинг (чтобы сервер не спал)
app.get('/ping', (req, res) => {
    res.send('Pong! I am awake.');
});

// 1. Получить все материалы
app.get('/api/materials', async (req, res) => {
  try {
    const snapshot = await ref.once('value');
    const data = snapshot.val() || {};
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Загрузить (Один файл за раз, очередь на фронтенде)
app.post('/api/upload', checkAuth, upload.single('file'), async (req, res) => {
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
        // Текстовый пост
        fileData.type = 'text';
        fileData.content = textContent;
        fileData.url = null;
        fileData.public_id = null; // Нет файла в облаке
    } else {
        // Файл
        if (!req.file) return res.status(400).send('Нет файла');

        const streamUpload = (fileBuffer) => {
            return new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    { resource_type: "auto", folder: "primizht_history" },
                    (error, result) => {
                        if (result) resolve(result);
                        else reject(error);
                    }
                );
                Readable.from(fileBuffer).pipe(stream);
            });
        };

        const result = await streamUpload(req.file.buffer);
        
        fileData.type = result.format || 'file';
        fileData.url = result.secure_url;
        fileData.content = null;
        fileData.public_id = result.public_id; // ВАЖНО: ID для удаления
    }

    await newFileRef.set(fileData);
    res.json(fileData);

  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// 3. Редактирование (Название, Категория, Текст)
app.put('/api/edit/:id', checkAuth, async (req, res) => {
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

// 4. Удаление (База + Cloudinary)
app.delete('/api/delete/:id', checkAuth, async (req, res) => {
    try {
        const fileId = req.params.id;
        const itemRef = ref.child(fileId);
        
        // Сначала получаем данные о файле, чтобы узнать public_id
        const snapshot = await itemRef.once('value');
        const item = snapshot.val();

        if (item && item.public_id) {
            // Удаляем из Cloudinary
            try {
                // Определяем тип ресурса (image, video или raw для pdf/doc)
                let resourceType = 'image';
                if (item.type === 'pdf' || item.type.includes('doc') || item.type.includes('ppt')) {
                    resourceType = 'raw'; 
                } else if (item.type === 'mp4' || item.type === 'avi') {
                    resourceType = 'video';
                }
                
                await cloudinary.uploader.destroy(item.public_id, { resource_type: resourceType });
                console.log(`Deleted from Cloud: ${item.public_id}`);
            } catch (cloudError) {
                console.error("Cloudinary delete error:", cloudError);
                // Не прерываем, всё равно удалим из базы
            }
        }

        // Удаляем из базы
        await itemRef.remove();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Запуск
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
