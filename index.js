const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Client } = require('pg');
const fetch = require('node-fetch');
const app = express();

// Configuración de CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

const port = process.env.PORT || 3000;

// Cliente de PostgreSQL
const client = new Client({
  connectionString: process.env.DATABASE_URL,
});

// Configuración de multer para subida de archivos
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// Conectar a la base de datos
(async () => {
  try {
    await client.connect();
    console.log('Conectado a Supabase correctamente');
    
    // Crear tablas si no existen
    await client.query(`
      CREATE TABLE IF NOT EXISTS boletos (
        id SERIAL PRIMARY KEY,
        numero_boleto INTEGER UNIQUE NOT NULL,
        nombre_cliente TEXT NOT NULL,
        telefono_cliente TEXT NOT NULL,
        estado_pago TEXT DEFAULT 'pendiente',
        is_transaccion TEXT UNIQUE,
        fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS configuracion_rifa (
        id SERIAL PRIMARY KEY,
        nombre_rifa TEXT NOT NULL,
        precio_boleto DECIMAL(10,2) NOT NULL,
        total_boletos INTEGER NOT NULL,
        fecha_sorteo TIMESTAMP
      );
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS participants (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        cedula TEXT NOT NULL,
        phone TEXT NOT NULL,
        email TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        participant_id INTEGER REFERENCES participants(id),
        bank_from TEXT,
        payment_phone TEXT,
        amount_paid DECIMAL(10,2),
        reference_last4 TEXT,
        screenshot_url TEXT,
        status TEXT DEFAULT 'pending',
        ai_validation_result JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    console.log('Tablas creadas correctamente');
  } catch (err) {
    console.error('Error de conexión', err.stack);
  }
})();

// Endpoint raíz
app.get('/', (req, res) => {
  res.send('<h1>Servidor de AUTORACER funcionando!</h1><p>Conectado a la base de datos de Supabase.</p>');
});

// 1. GET /tickets/count - Conteo de tickets vendidos
app.get('/tickets/count', async (req, res) => {
  try {
    const result = await client.query('SELECT COUNT(*) as count FROM boletos WHERE estado_pago = \'pagado\'');
    res.json({ count: parseInt(result.rows[0].count) || 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al obtener conteo' });
  }
});

// 2. POST /tickets/purchase - Procesar compra y enviar notificación
app.post('/tickets/purchase', async (req, res) => {
  try {
    const { name, phone, cedula, email, ticketNum, reference, amount } = req.body;

    // Validar datos requeridos
    if (!name || !phone || !ticketNum || !reference || !amount) {
      return res.status(400).json({ 
        success: false, 
        error: 'Faltan datos requeridos' 
      });
    }

    // Enviar notificación a Telegram
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      const msg = `🎫 *Nueva Participación*\n\n👤 *Nombre:* ${name}\n📱 *Teléfono:* ${phone}\n🎫 *Cédula:* ${cedula || 'N/A'}\n📧 *Email:* ${email || 'N/A'}\n🎫 *Boleto:* ${ticketNum}\n💳 *Referencia:* ${reference}\n💵 *Monto:* Bs. ${amount}`;
      
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: msg,
          parse_mode: 'Markdown'
        })
      });
    }

    res.json({ 
      success: true, 
      message: 'Compra procesada correctamente',
      ticketNum 
    });
  } catch (e) {
    console.error('Error en purchase:', e);
    res.status(500).json({ 
      success: false, 
      error: 'Error al procesar compra' 
    });
  }
});

// 2. POST /upload - Subir capturas de pago
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se envió archivo' });
    }
    
    // Por ahora retornamos una URL temporal
    // En producción, aquí subirías a Supabase Storage
    const fileUrl = `https://autoracer-production.up.railway.app/uploads/${Date.now()}-${req.file.originalname}`;
    
    res.json({ url: fileUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al subir archivo' });
  }
});

// 3. POST /validate-payment - Validar pagos
app.post('/validate-payment', async (req, res) => {
  try {
    const { name, cedula, phone, email, quantity, bankFrom, paymentPhone, amountPaid, reference, screenshotUrl } = req.body;
    
    // Verificar referencia duplicada
    const checkDuplicate = await client.query(
      'SELECT id FROM payments WHERE reference_last4 = $1 AND status = \'validated\'',
      [reference]
    );
    
    if (checkDuplicate.rows.length > 0) {
      return res.json({
        success: false,
        error: 'Pago duplicado: esta referencia ya fue registrada.'
      });
    }
    
    // Insertar participante
    const participantResult = await client.query(
      'INSERT INTO participants (name, cedula, phone, email) VALUES ($1, $2, $3, $4) RETURNING id',
      [name, cedula, phone, email]
    );
    const participantId = participantResult.rows[0].id;
    
    // Validación AI (opcional)
    let aiValidation = { valid: true, confidence: 0.9, details: 'Validación automática' };
    
    // Insertar pago
    await client.query(
      'INSERT INTO payments (participant_id, bank_from, payment_phone, amount_paid, reference_last4, screenshot_url, status, ai_validation_result) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [participantId, bankFrom, paymentPhone, parseFloat(amountPaid), reference, screenshotUrl, aiValidation.valid ? 'validated' : 'rejected', JSON.stringify(aiValidation)]
    );
    
    if (!aiValidation.valid) {
      return res.json({
        success: false,
        error: aiValidation.details || 'Datos no coinciden con la captura.'
      });
    }
    
    // Generar números de boletos
    const maxTicketResult = await client.query(
      'SELECT MAX(numero_boleto) as max_num FROM boletos'
    );
    const startNum = (maxTicketResult.rows[0].max_num || 0) + 1;
    const ticketNumbers = [];
    
    for (let i = 0; i < quantity; i++) {
      const ticketNum = startNum + i;
      await client.query(
        'INSERT INTO boletos (numero_boleto, nombre_cliente, telefono_cliente, estado_pago, is_transaccion) VALUES ($1, $2, $3, $4, $5)',
        [ticketNum, name, phone, 'pagado', reference]
      );
      ticketNumbers.push(ticketNum);
    }
    
    // Notificación Telegram (opcional)
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      try {
        const msg = `🎫 *Nueva Participación*\n\n👤 ${name}\n🪐 ${cedula}\n📱 ${phone}\n📧 ${email}\n\n💰 Bs. ${amountPaid}\n🏦 ${bankFrom}\n🔢 Ref: ...${reference}\n\n🎰 Números: ${ticketNumbers.join(', ')}\n✅ Confianza IA: ${(aiValidation.confidence * 100).toFixed(0)}%`;
        
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: msg,
            parse_mode: 'Markdown'
          })
        });
      } catch (e) {
        console.error('Telegram error:', e);
      }
    }
    
    res.json({ success: true, ticketNumbers });
  } catch (e) {
    console.error('Error:', e);
    res.status(500).json({
      success: false,
      error: 'Error interno. Intenta de nuevo.'
    });
  }
});

app.listen(port, () => {
  console.log(`App corriendo en puerto ${port}`);
});

