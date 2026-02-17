import express from "express";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";

const app = express();

// Aumentar límite de tamaño de JSON y urlencoded
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// GET /tickets/count
app.get("/tickets/count", async (req, res) => {
  try {
    const { count } = await supabase
      .from("tickets")
      .select("*", { count: "exact", head: true });
    res.json({ count: count || 0 });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: "Error al obtener conteo" });
  }
});

// POST /upload
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se envió archivo" });
    }

    const ext = req.file.originalname.split(".").pop();
    const filePath = `${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.${ext}`;

    const { error } = await supabase.storage
      .from("payment-screenshots")
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    if (error) {
      console.error("Storage error:", error);
      throw error;
    }

    const { data } = supabase.storage
      .from("payment-screenshots")
      .getPublicUrl(filePath);

    res.json({ url: data.publicUrl });
  } catch (e: any) {
    console.error("Upload error:", e);
    res
      .status(500)
      .json({ error: "Error al subir archivo: " + e.message });
  }
});

// POST /validate-payment
app.post("/validate-payment", async (req, res) => {
  try {
    // Body que manda Lovable:
    // { name, idNumber, phone, bank, reference, amount, paymentImageUrl }

    const {
      name,
      idNumber,
      phone,
      bank,
      reference,
      amount,
      paymentImageUrl,
      email,
      quantity,
    } = req.body;

    const cedula = idNumber || "";
    const bankFrom = bank || "";
    const paymentPhone = phone;
    const amountPaid = amount;
    const screenshotUrl = paymentImageUrl || "";
    const qty = quantity ? Number(quantity) : 1;

    console.log("Validando pago:", {
      name,
      cedula,
      phone,
      bankFrom,
      reference,
      amountPaid,
      screenshotUrl,
    });

    // Check duplicate reference
    const { data: existing } = await supabase
      .from("payments")
      .select("id")
      .eq("reference_last4", reference)
      .eq("status", "validated")
      .maybeSingle();

    if (existing) {
      return res.json({
        success: false,
        error: "Pago duplicado: esta referencia ya fue registrada.",
      });
    }

    // Validación básica (sin IA por ahora)
    const aiValidation = {
      valid: true,
      confidence: 0.8,
      details: "Validación automática aprobada",
    };

    // Insert participant
    const { data: participant, error: pErr } = await supabase
      .from("participants")
      .insert({
        name,
        cedula,
        phone,
        email: email || "",
      })
      .select("id")
      .single();

    if (pErr) {
      console.error("Error insertando participante:", pErr);
      throw pErr;
    }

    console.log("Participante creado:", participant.id);

    // Insert payment
    const { error: payErr } = await supabase.from("payments").insert({
      participant_id: participant.id,
      bank_from: bankFrom,
      payment_phone: paymentPhone,
      amount_paid: parseFloat(amountPaid),
      reference_last4: reference,
      screenshot_url: screenshotUrl,
      status: "validated",
      ai_validation_result: aiValidation,
    });

    if (payErr) {
      console.error("Error insertando pago:", payErr);
      throw payErr;
    }

    console.log("Pago registrado");

    // Generate ticket numbers
    const { data: maxTicket } = await supabase
      .from("tickets")
      .select("ticket_number")
      .order("ticket_number", { ascending: false })
      .limit(1)
      .maybeSingle();

    const startNum = (maxTicket?.ticket_number || 0) + 1;
    const ticketNumbers: number[] = [];
    const ticketInserts: any[] = [];

    for (let i = 0; i < qty; i++) {
      const num = startNum + i;
      ticketNumbers.push(num);
      ticketInserts.push({
        participant_id: participant.id,
        ticket_number: num,
      });
    }

    const { error: tErr } = await supabase
      .from("tickets")
      .insert(ticketInserts);

    if (tErr) {
      console.error("Error insertando tickets:", tErr);
      throw tErr;
    }

    console.log("Tickets generados:", ticketNumbers);

    // Telegram notification (opcional)
    try {
      const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;

      if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        const msg = `🎫 *Nueva Participación*\\n\\n👤 ${name}\\n🪪 ${
          cedula || "N/A"
        }\\n📱 ${phone}\\n📧 ${email || "N/A"}\\n\\n💰 Bs. ${amountPaid}\\n🏦 ${
          bankFrom || "N/A"
        }\\n🔢 Ref: ...${reference}\\n\\n🎰 Números: ${ticketNumbers.join(
          ", "
        )}`;

        await fetch(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: TELEGRAM_CHAT_ID,
              text: msg,
              parse_mode: "Markdown",
            }),
          }
        );
      }
    } catch (e) {
      console.error("Telegram error:", e);
    }

    res.json({ success: true, ticketNumbers });
  } catch (e: any) {
    console.error("Error general:", e);
    res.status(500).json({
      success: false,
      error: "Error interno: " + e.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
