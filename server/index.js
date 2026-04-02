require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const fileUpload = require('express-fileupload');
const path = require('path');
const { initDb } = require('./db');
const { auth } = require('./middleware/auth');
const { getSignedUrl } = require('./utils/storage');
const { processAutopayCharges, processEventCompletions } = require('./utils/balanceScheduler');
const { processScheduledAutoAssigns } = require('./utils/autoAssignScheduler');

const app = express();
app.set('trust proxy', 1); // Required for Render/Heroku reverse proxies (rate limiter, IP detection)
const PORT = process.env.PORT || 5000;

// Security headers (CSP disabled — React inline styles require careful CSP tuning)
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// Middleware — allow requests from both public site and admin subdomain
const allowedOrigins = [
  process.env.CLIENT_URL || 'http://localhost:3000',
  'https://drbartender.com',
  'https://www.drbartender.com',
  'https://admin.drbartender.com',
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (server-to-server, curl, mobile apps)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// Stripe webhook needs raw body — must be registered BEFORE express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload({
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024 },
  abortOnLimit: true,
  useTempFiles: false
}));

// Protected file download — admin and managers only
app.get('/api/files/:filename', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Access denied' });
  }
  // path.basename strips any directory traversal attempts (e.g. "../../etc/passwd")
  const filename = path.basename(req.params.filename);
  try {
    const url = await getSignedUrl(filename);
    res.redirect(url);
  } catch (err) {
    console.error('File download error:', err);
    res.status(404).json({ error: 'File not found' });
  }
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/progress', require('./routes/progress'));
app.use('/api/agreement', require('./routes/agreement'));
app.use('/api/contractor', require('./routes/contractor'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/application', require('./routes/application'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/shifts', require('./routes/shifts'));
app.use('/api/drink-plans', require('./routes/drinkPlans'));
app.use('/api/cocktails', require('./routes/cocktails'));
app.use('/api/mocktails', require('./routes/mocktails'));
app.use('/api/proposals', require('./routes/proposals'));
app.use('/api/clients', require('./routes/clients'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/stripe', require('./routes/stripe'));
app.use('/api/calendar', require('./routes/calendar'));
app.use('/api/blog', require('./routes/blog'));
app.use('/api/client-auth', require('./routes/clientAuth'));
app.use('/api/client-portal', require('./routes/clientPortal'));

// Health check — must be registered BEFORE the React catch-all below
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Frontend is served separately on Vercel

async function start() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`✓ Server running on port ${PORT}`);

      // Autopay balance scheduler — check hourly for due balances
      setTimeout(processAutopayCharges, 30000); // initial run after 30s
      setInterval(processAutopayCharges, 60 * 60 * 1000); // then every hour

      // Auto-complete events — check hourly for ended, fully-paid events
      setTimeout(processEventCompletions, 45000); // initial run after 45s
      setInterval(processEventCompletions, 60 * 60 * 1000); // then every hour

      // Auto-assign scheduler — check hourly for shifts needing auto-assignment
      setTimeout(processScheduledAutoAssigns, 60000); // initial run after 60s
      setInterval(processScheduledAutoAssigns, 60 * 60 * 1000); // then every hour
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
