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

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const port = process.env.PORT || 3000;

// Cliente de PostgreSQL
const client = new Client({
  connectionString: process.env.DATABASE_URL,
});

// Configuración de multer para subida de archivos
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
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
        screenshot_base64 TEXT,
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

// NUEVA FUNCIÓN: Validar pago con OpenAI GPT-4 Vision
async function validatePaymentWithAI(imageBase64, expectedData) {
  if (!process.env.OPENAI_API_KEY) {
    console.warn('⚠️ OPENAI_API_KEY no configurado, usando validación básica');
    return {
      valid: true,
      confidence: 0.5,
      details: 'Validación automática (sin IA visual). Configura OPENAI_API_KEY para validación completa.',
      provider: 'basic'
    };
  }

  try {
    const prompt = `Eres un experto analizando comprobantes de pago móvil en Venezuela.

Analiza esta captura de pantalla de un pago móvil y verifica:

1. **¿Es un comprobante de pago móvil real?** (debe mostrar interfaz bancaria venezolana)
2. **Monto:** ¿El monto visible es aproximadamente ${expectedData.amountPaid} Bs?
3. **Referencia:** ¿Los últimos 4 dígitos de la referencia son "${expectedData.reference}"?
4. **Banco origen:** ¿El banco visible coincide con "${expectedData.bankFrom}"?
5. **Teléfono:** ¿El número de teléfono del pago es "${expectedData.paymentPhone}"?
6. **Coherencia:** ¿Los datos son coherentes y sin manipulación evidente?

**IMPORTANTE:** 
- Sé flexible con formatos de monto (puede tener comas, puntos, símbolo Bs)
- Los últimos 4 dígitos de referencia deben coincidir exactamente
- Si falta algún dato pero lo demás es correcto, indicarlo en details

Responde SOLO en formato JSON válido:
{
  "valid": true/false,
  "confidence": 0.0-1.0,
  "details": "explicación breve en español",
  "monto_detectado": "monto que viste",
  "referencia_detectada": "últimos 4 dígitos que viste",
  "banco_detectado": "banco que identificaste"
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${imageBase64}`,
                  detail: 'high'
                }
              }
            ]
          }
        ],
        max_tokens: 500,
        temperature: 0.2
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Error de OpenAI:', errorText);
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices[0].message.content.trim();
    
    // Extraer JSON del contenido (por si viene con markdown)
    let jsonContent = content;
    if (content.includes('```json')) {
      jsonContent = content.split('```json')[1].split('```')[0].trim();
    } else if (content.includes('```')) {
      jsonContent = content.split('```')[1].split('```')[0].trim();
    }
    
    const result = JSON.parse(jsonContent);
    result.provider = 'openai-gpt4o';
    
    return result;
  } catch (error) {
    console.error('Error en validación con IA:', error);
    return {
      valid: false,
      confidence: 0,
      details: `Error de validación IA: ${error.message}`,
      provider: 'error'
    };
  }
}

// Endpoint raíz
app.get('/', (req, res) => {
  res.send(`
    <h1>🏎️ Servidor de AUTORACER funcionando!</h1>
    <p>✅ Conectado a la base de datos de Supabase.</p>
    <p>✅ Validación IA: ${process.env.OPENAI_API_KEY ? 'Configurada' : '⚠️ Falta OPENAI_API_KEY'}</p>
    <hr>
    <h3>Endpoints disponibles:</h3>
    <ul>
      <li>GET /tickets/count - Conteo de tickets</li>
      <li>POST /tickets/purchase - Compra de tickets</li>
      <li>POST /upload - Subir captura</li>
      <li>POST /validate-payment - Validar pago con IA</li>
      <li>POST /test-ai - Probar validación IA</li>
    </ul>
  `);
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

// 3. POST /upload - MEJORADO: Subir capturas de pago
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se envió archivo' });
    }
    
    // Convertir a base64 para almacenar y procesar
    const base64Image = req.file.buffer.toString('base64');
    
    // Generar URL de referencia (puedes mejorar esto guardando en Supabase Storage)
    const imageId = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Por ahora retornamos el base64 directamente
    // En producción, podrías guardar en Supabase Storage y retornar URL pública
    res.json({ 
      success: true,
      url: imageId,
      base64: base64Image,
      message: 'Imagen procesada correctamente'
    });
  } catch (e) {
    console.error('Error en upload:', e);
    res.status(500).json({ error: 'Error al subir archivo' });
  }
});

// 4. POST /validate-payment - MEJORADO: Validar pagos con IA
app.post('/validate-payment', async (req, res) => {
  try {
    const { 
      name, cedula, phone, email, quantity, 
      bankFrom, paymentPhone, amountPaid, reference, 
      screenshotUrl, screenshotBase64 
    } = req.body;
    
    // Validación de datos requeridos
    if (!name || !phone || !reference || !amountPaid || !quantity) {
      return res.status(400).json({
        success: false,
        error: 'Faltan datos requeridos: name, phone, reference, amountPaid, quantity'
      });
    }

    if (!screenshotBase64 && !screenshotUrl) {
      return res.status(400).json({
        success: false,
        error: 'Debes enviar screenshotBase64 o screenshotUrl'
      });
    }
    
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
      [name, cedula || '', phone, email || '']
    );
    const participantId = participantResult.rows[0].id;
    
    // VALIDACIÓN CON IA
    const imageBase64 = screenshotBase64 || screenshotUrl; // Si es base64 lo usamos directo
    const aiValidation = await validatePaymentWithAI(imageBase64, {
      amountPaid,
      reference,
      bankFrom: bankFrom || 'cualquier banco',
      paymentPhone: paymentPhone || phone
    });
    
    console.log('Resultado IA:', aiValidation);
    
    // Insertar pago con resultado de IA
    await client.query(
      'INSERT INTO payments (participant_id, bank_from, payment_phone, amount_paid, reference_last4, screenshot_url, screenshot_base64, status, ai_validation_result) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [
        participantId, 
        bankFrom || '', 
        paymentPhone || phone, 
        parseFloat(amountPaid), 
        reference, 
        screenshotUrl || '', 
        screenshotBase64 ? screenshotBase64.substring(0, 100) + '...' : '', // Guardar solo parte para no saturar BD
        aiValidation.valid ? 'validated' : 'rejected', 
        JSON.stringify(aiValidation)
      ]
    );
    
    // Si la IA rechaza el pago
    if (!aiValidation.valid) {
      return res.json({
        success: false,
        error: aiValidation.details || 'El pago no pudo ser validado por la IA.',
        aiResult: aiValidation
      });
    }
    
    // Si la confianza es muy baja, advertir
    if (aiValidation.confidence < 0.6) {
      return res.json({
        success: false,
        error: `Confianza de validación baja (${(aiValidation.confidence * 100).toFixed(0)}%). ${aiValidation.details}`,
        aiResult: aiValidation
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
    
    // Notificación Telegram
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      try {
        const msg = `🎫 *Nueva Participación VALIDADA con IA*\n\n👤 ${name}\n🪐 ${cedula || 'N/A'}\n📱 ${phone}\n📧 ${email || 'N/A'}\n\n💰 Bs. ${amountPaid}\n🏦 ${bankFrom || 'N/A'}\n📞 Tel. pago: ${paymentPhone || phone}\n🔢 Ref: ...${reference}\n\n🎰 *Números:* ${ticketNumbers.join(', ')}\n✅ *Confianza IA:* ${(aiValidation.confidence * 100).toFixed(0)}%\n📝 *Detalles:* ${aiValidation.details}`;
        
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
    
    res.json({ 
      success: true, 
      ticketNumbers,
      aiValidation
    });
  } catch (e) {
    console.error('Error:', e);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor. Intenta de nuevo.'
    });
  }
});

// 5. POST /test-ai - Probar validación IA con imagen de prueba
app.post('/test-ai', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Envía una imagen para probar' });
    }

    const base64Image = req.file.buffer.toString('base64');
    const testData = {
      amountPaid: req.body.amount || '100',
      reference: req.body.reference || '1234',
      bankFrom: req.body.bank || 'Banco de Venezuela',
      paymentPhone: req.body.phone || '04141234567'
    };

    const result = await validatePaymentWithAI(base64Image, testData);

    res.json({
      success: true,
      testData,
      aiResult: result,
      message: '✅ Prueba de IA completada'
    });
  } catch (e) {
    console.error('Error en test-ai:', e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(port, () => {
  console.log(`🚀 App corriendo en puerto ${port}`);
  console.log(`🤖 IA: ${process.env.OPENAI_API_KEY ? '✅ Configurada' : '⚠️ Falta OPENAI_API_KEY'}`);
});
