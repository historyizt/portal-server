const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const admin = require('firebase-admin');
const { Readable } = require('stream');

const app = express();
app.use(cors()); // Разрешаем доступ с сайта
app.use(express.json());

// 1. Настройка Firebase
// Получаем настройки из переменных Render
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL
});

const db = admin.database();
const ref = db.ref("materials");

// 2. Настройка Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_KEY,
  api_secret: process.env.CLOUDINARY_SECRET
});

// Настройка Multer (принимаем файлы в память)
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } 
});

// --- ПРОВЕРКА ПАРОЛЯ АДМИНА ---
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

// 1. Получить все материалы (Доступно всем)
app.get('/api/materials', async (req, res) => {
  try {
    const snapshot = await ref.once('value');
    const data = snapshot.val() || {};
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Загрузить новый материал (Файл или Текст)
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

    // ВАРИАНТ А: Текстовый пост
    if (isTextPost === 'true') {
        fileData.type = 'text';
        fileData.content = textContent;
        fileData.url = null;
    } 
    // ВАРИАНТ Б: Загрузка файла
    else {
        if (!req.file) return res.status(400).send('Нет файла');

        // Отправка в Cloudinary через поток
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
        
        fileData.type = result.format || 'file'; // pdf, jpg, docx...
        fileData.url = result.secure_url;
        fileData.content = null;
    }

    // Сохранение записи в базу
    await newFileRef.set(fileData);
    
    res.json(fileData);

  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "Ошибка загрузки на сервере" });
  }
});

// 3. Удалить материал
app.delete('/api/delete/:id', checkAuth, async (req, res) => {
    try {
        const fileId = req.params.id;
        await ref.child(fileId).remove();
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
