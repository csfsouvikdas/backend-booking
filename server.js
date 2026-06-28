// Node.js (Express) backend server with local file persistence, env configs, and payment/credentials/email APIs.
// Run with: node backend/server.js

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import Razorpay from "razorpay";
import { fileURLToPath } from "url";

// Load configurations from environment variables
const PORT = process.env.PORT || 4000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "rzp_test_REPLACEME";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "rzp_test_secret_REPLACEME";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, "database.json");

const app = express();
app.use(cors());
app.use(express.json());

// Helper to generate dynamic dates for seeding (current month)
const today = new Date();
const ym = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
const d = (day) => `${ym}-${String(day).padStart(2, "0")}`;

const rand = (n = 8) => {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: n }, () => c[Math.floor(Math.random() * c.length)]).join("");
};

const defaultDb = {
  services: [],
  bookings: [],
  availability: {
    workingDays: [1, 2, 3, 4, 5],
    startTime: "10:00",
    endTime: "18:00",
    bufferMinutes: 15,
    blockedDates: [],
  },
};

let db = { ...defaultDb };

// Load database from file
function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, "utf-8");
      const parsed = JSON.parse(data);

      // Filter out duplicate bookings by ID
      const uniqueBookings = [];
      const seenB = new Set();
      for (const b of parsed.bookings || []) {
        if (b && b.id && !seenB.has(b.id)) {
          seenB.add(b.id);
          uniqueBookings.push(b);
        }
      }

      // Filter out duplicate services by ID
      const uniqueServices = [];
      const seenS = new Set();
      for (const s of parsed.services || []) {
        if (s && s.id && !seenS.has(s.id)) {
          seenS.add(s.id);
          uniqueServices.push(s);
        }
      }

      db = {
        services: uniqueServices,
        bookings: uniqueBookings,
        availability: parsed.availability || {
          workingDays: [1, 2, 3, 4, 5],
          startTime: "10:00",
          endTime: "18:00",
          bufferMinutes: 15,
          blockedDates: [],
        },
      };

      saveDb();
      console.log("Database loaded and deduplicated successfully from database.json");
    } else {
      console.log("No database.json found. Seeding with default data...");
      saveDb();
    }
  } catch (err) {
    console.error("Error loading database, resetting to defaults:", err);
    db = {
      services: [],
      bookings: [],
      availability: {
        workingDays: [1, 2, 3, 4, 5],
        startTime: "10:00",
        endTime: "18:00",
        bufferMinutes: 15,
        blockedDates: [],
      },
    };
    saveDb();
  }
}

// Save database to file
function saveDb() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf-8");
  } catch (err) {
    console.error("Error saving database:", err);
  }
}

loadDb();

// EmailJS dispatch helper
async function sendEmail(kind, payload) {
  if (kind === "received") {
    // "booking received" email is disabled/removed as requested
    return;
  }

  const serviceId = process.env.EMAILJS_SERVICE_ID;
  const defaultTemplateId = process.env.EMAILJS_TEMPLATE_ID;
  const publicKey = process.env.EMAILJS_PUBLIC_KEY;
  const privateKey = process.env.EMAILJS_PRIVATE_KEY;

  if (!serviceId || serviceId.startsWith("YOUR_")) {
    console.warn(`[email] EmailJS variables are not set. Logging email payload to console:`, {
      kind,
      payload,
    });
    return;
  }

  // Resolve template ID based on the kind of email
  let templateId = defaultTemplateId;
  if (kind === "received" && process.env.EMAILJS_TEMPLATE_ID_RECEIVED) {
    templateId = process.env.EMAILJS_TEMPLATE_ID_RECEIVED;
  } else if (kind === "confirmed" && process.env.EMAILJS_TEMPLATE_ID_CONFIRMED) {
    templateId = process.env.EMAILJS_TEMPLATE_ID_CONFIRMED;
  } else if (kind === "cancellation" && process.env.EMAILJS_TEMPLATE_ID_CANCELLED) {
    templateId = process.env.EMAILJS_TEMPLATE_ID_CANCELLED;
  }

  // Construct dynamic subject and message based on the email "kind"
  let subject = "";
  let title = "";
  let message = "";

  if (kind === "received") {
    subject = `Appointment Request Placed: ${payload.service} (Ref: ${payload.referenceId})`;
    title = "Appointment Request Placed Successfully";
    message = `We have received your appointment request. Your Reference ID is ${payload.referenceId}. Here are the details of your appointment.`;
  } else if (kind === "confirmed") {
    subject = `Appointment Confirmed: ${payload.service} (Ref: ${payload.referenceId})`;
    title = "Your Appointment is Confirmed!";
    message = `Great news! Your appointment has been confirmed by the administrator. We look forward to seeing you.`;
  } else if (kind === "cancellation") {
    subject = `Appointment Cancelled: ${payload.service} (Ref: ${payload.referenceId})`;
    title = "Appointment Cancelled";
    message = `Your appointment has been cancelled. If you have questions, please reach out.`;
  } else {
    subject = `Booking Notification: ${payload.service} (Ref: ${payload.referenceId})`;
    title = "Booking Update";
    message = `You have received an update for your booking.`;
  }

  try {
    const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id: serviceId,
        template_id: templateId,
        user_id: publicKey,
        accessToken: privateKey,
        template_params: {
          kind,
          subject,
          title,
          message,
          to_email: payload.email,
          email: payload.email,
          reply_to: payload.email,
          to_name: payload.clientName,
          client_name: payload.clientName,
          service: payload.service,
          amount: payload.amount !== undefined ? `₹${payload.amount}` : "N/A",
          date: payload.date,
          time: payload.time,
          reference_id: payload.referenceId,
        },
      }),
    });
    if (res.ok) {
      console.log(`[email] ${kind} email sent successfully to ${payload.email}`);
    } else {
      const text = await res.text();
      console.warn(`[email] EmailJS failed to send email. Status: ${res.status}. Body: ${text}`);
    }
  } catch (err) {
    console.warn("[email] send failed (non-blocking):", err);
  }
}

// Root route
app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "Booking App API Server is running!" });
});

// Chrome DevTools well-known route to suppress browser warnings
app.get("/.well-known/appspecific/com.chrome.devtools.json", (_req, res) => {
  res.json({ ok: true });
});

// General Email trigger route
app.post("/api/send-email", async (req, res) => {
  const { kind, payload } = req.body;
  if (!kind || !payload) {
    return res.status(400).json({ error: "kind and payload are required" });
  }
  await sendEmail(kind, payload);
  res.json({ ok: true });
});

// Services API Endpoints
app.get("/api/services", (_req, res) => {
  res.json(db.services);
});

app.post("/api/services", (req, res) => {
  const service = req.body;
  const exists = db.services.some((s) => s.id === service.id);
  if (exists) {
    db.services = db.services.map((s) => (s.id === service.id ? service : s));
  } else {
    db.services.push(service);
  }
  saveDb();
  res.json(service);
});

app.put("/api/services/:id", (req, res) => {
  const exists = db.services.some((s) => s.id === req.params.id);
  if (exists) {
    db.services = db.services.map((s) => (s.id === req.params.id ? req.body : s));
  } else {
    db.services.push(req.body);
  }
  saveDb();
  res.json(req.body);
});

app.delete("/api/services/:id", (req, res) => {
  db.services = db.services.filter((s) => s.id !== req.params.id);
  saveDb();
  res.json({ ok: true });
});

// Bookings API Endpoints
app.get("/api/bookings", (_req, res) => {
  res.json(db.bookings);
});

app.post("/api/bookings", (req, res) => {
  const booking = req.body;
  if (!booking.id) {
    booking.id = rand(8);
  }
  const exists = db.bookings.some((b) => b.id === booking.id);
  if (exists) {
    db.bookings = db.bookings.map((b) => (b.id === booking.id ? booking : b));
  } else {
    booking.status = "pending"; // Start in requested/pending state
    db.bookings.push(booking);
  }
  saveDb();

  // Send "received" email immediately ONLY if the booking is free
  // Paid bookings will send this email after verification
  const svc = db.services.find((s) => s.id === booking.serviceId);
  const isFree = svc ? svc.type === "free" : true;
  if (isFree) {
    sendEmail("received", {
      clientName: booking.clientName,
      email: booking.email,
      service: svc ? svc.name : "Session",
      amount: 0,
      date: booking.date,
      time: booking.time,
      referenceId: booking.id,
    });
  }

  res.json(booking);
});

app.patch("/api/bookings/:id", (req, res) => {
  const oldBooking = db.bookings.find((b) => b.id === req.params.id);
  const exists = !!oldBooking;

  if (exists) {
    db.bookings = db.bookings.map((b) => (b.id === req.params.id ? { ...b, ...req.body } : b));
  } else {
    db.bookings.push({ id: req.params.id, ...req.body });
  }
  saveDb();

  const newBooking = db.bookings.find((b) => b.id === req.params.id);

  if (oldBooking && newBooking) {
    const svc = db.services.find((s) => s.id === newBooking.serviceId);
    const svcName = svc ? svc.name : "Session";
    const amount = svc ? svc.price * (newBooking.attendees || 1) : 0;

    // Trigger confirmation email if status transitioned to confirmed (e.g. by admin)
    if (oldBooking.status !== "confirmed" && newBooking.status === "confirmed") {
      sendEmail("confirmed", {
        clientName: newBooking.clientName,
        email: newBooking.email,
        service: svcName,
        amount,
        date: newBooking.date,
        time: newBooking.time,
        referenceId: newBooking.id,
      });
    }
    // Trigger Cancellation email if status changed to cancelled
    else if (oldBooking.status !== "cancelled" && newBooking.status === "cancelled") {
      sendEmail("cancellation", {
        clientName: newBooking.clientName,
        email: newBooking.email,
        service: svcName,
        amount,
        date: newBooking.date,
        time: newBooking.time,
        referenceId: newBooking.id,
      });
    }
    // Trigger Reschedule confirmation email
    else if (
      (oldBooking.date !== newBooking.date || oldBooking.time !== newBooking.time) &&
      newBooking.status === "confirmed"
    ) {
      sendEmail("confirmed", {
        clientName: newBooking.clientName,
        email: newBooking.email,
        service: svcName,
        amount,
        date: newBooking.date,
        time: newBooking.time,
        referenceId: newBooking.id,
      });
    }
  }

  res.json({ ok: true });
});

// Availability API Endpoints
app.get("/api/availability", (_req, res) => {
  res.json(db.availability);
});

app.put("/api/availability", (req, res) => {
  db.availability = req.body;
  saveDb();
  res.json(db.availability);
});

// Authentication API Endpoints
app.get("/api/admin/credentials", (_req, res) => {
  res.json({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
});

app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    res.json({ success: true, message: "Login successful" });
  } else {
    res.status(401).json({ success: false, error: "Invalid credentials" });
  }
});

// Payment API Endpoints (Razorpay Integration)
app.post("/api/payments/create-order", async (req, res) => {
  const { amountInr } = req.body;
  if (!amountInr) {
    return res.status(400).json({ error: "amountInr is required" });
  }

  // Graceful mockup if keys are placeholders
  if (
    RAZORPAY_KEY_ID === "rzp_test_REPLACEME" ||
    RAZORPAY_KEY_SECRET === "rzp_test_secret_REPLACEME"
  ) {
    const mockOrder = {
      id: `order_mock_${rand(12)}`,
      amount: Math.round(amountInr * 100),
      currency: "INR",
      receipt: `receipt_${rand(8)}`,
      isMock: true,
      keyId: RAZORPAY_KEY_ID,
    };
    return res.json(mockOrder);
  }

  try {
    const razorpay = new Razorpay({
      key_id: RAZORPAY_KEY_ID,
      key_secret: RAZORPAY_KEY_SECRET,
    });

    const order = await razorpay.orders.create({
      amount: Math.round(amountInr * 100), // in paise
      currency: "INR",
      receipt: `receipt_${rand(8)}`,
    });

    res.json({ ...order, isMock: false, keyId: RAZORPAY_KEY_ID });
  } catch (err) {
    console.warn("Razorpay order creation failed, falling back to mock sandbox:", err);
    const mockOrder = {
      id: `order_mock_${rand(12)}`,
      amount: Math.round(amountInr * 100),
      currency: "INR",
      receipt: `receipt_${rand(8)}`,
      isMock: true,
      keyId: RAZORPAY_KEY_ID,
    };
    res.json(mockOrder);
  }
});

app.post("/api/payments/verify", (req, res) => {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature, bookingId, booking } =
    req.body;

  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
    return res.status(400).json({ error: "Missing required verification fields" });
  }

  const isMockOrder = razorpay_order_id.startsWith("order_mock_");
  let verified = false;

  if (
    isMockOrder ||
    RAZORPAY_KEY_ID === "rzp_test_REPLACEME" ||
    RAZORPAY_KEY_SECRET === "rzp_test_secret_REPLACEME"
  ) {
    verified = true;
  } else {
    try {
      const generated_signature = crypto
        .createHmac("sha256", RAZORPAY_KEY_SECRET)
        .update(razorpay_order_id + "|" + razorpay_payment_id)
        .digest("hex");

      verified = generated_signature === razorpay_signature;
    } catch (err) {
      console.error("Signature verification error:", err);
      verified = false;
    }
  }

  if (verified) {
    let syncedBooking;
    if (booking) {
      syncedBooking = { ...booking, payment: "paid", status: "pending" };
      db.bookings = db.bookings.filter((b) => b.id !== booking.id);
      db.bookings.push(syncedBooking);
      saveDb();

      // Trigger Email confirmation on creation success
      const svc = db.services.find((s) => s.id === syncedBooking.serviceId);
      sendEmail("received", {
        clientName: syncedBooking.clientName,
        email: syncedBooking.email,
        service: svc ? svc.name : "Session",
        amount: svc ? svc.price * (syncedBooking.attendees || 1) : 0,
        date: syncedBooking.date,
        time: syncedBooking.time,
        referenceId: syncedBooking.id,
      });

      res.json({
        success: true,
        message: "Payment verified and booking created",
        booking: syncedBooking,
      });
    } else if (bookingId) {
      db.bookings = db.bookings.map((b) => {
        if (b.id === bookingId) {
          syncedBooking = { ...b, payment: "paid", status: "pending" };
          return syncedBooking;
        }
        return b;
      });
      saveDb();

      if (syncedBooking) {
        const svc = db.services.find((s) => s.id === syncedBooking.serviceId);
        sendEmail("received", {
          clientName: syncedBooking.clientName,
          email: syncedBooking.email,
          service: svc ? svc.name : "Session",
          amount: svc ? svc.price * (syncedBooking.attendees || 1) : 0,
          date: syncedBooking.date,
          time: syncedBooking.time,
          referenceId: syncedBooking.id,
        });
      }

      res.json({ success: true, message: "Payment verified and booking updated" });
    } else {
      res.status(400).json({ success: false, error: "Missing booking context" });
    }
  } else {
    res.status(400).json({ success: false, error: "Signature verification failed" });
  }
});

// Reseed endpoint for convenience
app.post("/api/reseed", (_req, res) => {
  db = {
    ...defaultDb,
    bookings: defaultDb.bookings.map((b) => ({ ...b, id: rand() })),
  };
  saveDb();
  res.json({ ok: true, message: "Database reseeded" });
});

app.listen(PORT, () => console.log(`Backend listening on http://localhost:${PORT}`));
