# Dr. Bartender — Staff Onboarding Portal

A private contractor onboarding portal for approved Dr. Bartender staff members.

## Tech Stack

- **Backend**: Node.js + Express
- **Database**: PostgreSQL
- **Frontend**: React (Create React App)
- **Auth**: JWT with bcrypt
- **File Uploads**: express-fileupload
- **Deployment**: Render.com ready

---

## Project Structure

```
dr-bartender/
├── server/
│   ├── db/
│   │   ├── index.js          # DB connection + schema init
│   │   ├── schema.sql        # Full database schema
│   │   └── seed.js           # Admin account seeder
│   ├── middleware/
│   │   └── auth.js           # JWT auth + admin guard
│   ├── routes/
│   │   ├── auth.js           # Register / Login / Me
│   │   ├── progress.js       # Onboarding step tracking
│   │   ├── agreement.js      # Contractor agreement + signature
│   │   ├── contractor.js     # Contractor profile + file uploads
│   │   ├── payment.js        # Payment info + W-9 upload
│   │   └── admin.js          # Admin dashboard endpoints
│   ├── uploads/              # Uploaded files (local dev)
│   └── index.js              # Express entry point
├── client/
│   ├── public/
│   │   └── index.html
│   └── src/
│       ├── components/
│       │   ├── Layout.js         # Header + steps progress bar
│       │   ├── SignaturePad.js   # Canvas-based signature
│       │   └── FileUpload.js     # File upload widget
│       ├── context/
│       │   └── AuthContext.js    # Auth state
│       ├── pages/
│       │   ├── Register.js
│       │   ├── Login.js
│       │   ├── Welcome.js
│       │   ├── FieldGuide.js
│       │   ├── Agreement.js
│       │   ├── ContractorProfile.js
│       │   ├── PaydayProtocols.js
│       │   ├── Completion.js
│       │   ├── AdminDashboard.js
│       │   └── AdminUserDetail.js
│       ├── utils/
│       │   └── api.js            # Axios instance
│       ├── App.js
│       ├── index.js
│       └── index.css             # Global styles
├── .env.example
├── package.json
├── render.yaml
└── README.md
```

---

## Local Development Setup

### 1. Prerequisites

- Node.js 18+
- PostgreSQL (local or remote)

### 2. Clone & Install

```bash
git clone <your-repo>
cd dr-bartender
npm run install:all
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
PORT=5000
NODE_ENV=development
DATABASE_URL=postgresql://youruser:yourpass@localhost:5432/dr_bartender
JWT_SECRET=change-this-to-a-long-random-string
UPLOAD_DIR=./server/uploads
CLIENT_URL=http://localhost:3000
```

### 4. Create the Database

```bash
createdb dr_bartender
```

### 5. Seed Admin Account

```bash
npm run seed
```

Default admin credentials:
- Email: `admin@drbartender.com`
- Password: `DrBartender2024!`

**Change these immediately in production.**

### 6. Start Development Server

```bash
npm run dev
```

- Frontend: http://localhost:3000
- Backend API: http://localhost:5000

---

## Deployment on Render

### Option A: Using render.yaml (Recommended)

1. Push your code to a GitHub/GitLab repo.
2. In Render Dashboard → New → Blueprint
3. Connect your repo — Render will use `render.yaml`
4. Set environment variables as needed
5. Deploy

### Option B: Manual Setup

#### Create PostgreSQL Database
1. Render Dashboard → New → PostgreSQL
2. Name: `dr-bartender-db`
3. Note the Internal Connection String

#### Create Web Service
1. Render Dashboard → New → Web Service
2. Connect your repo
3. Build Command: `npm install && npm run build`
4. Start Command: `npm start`
5. Environment Variables:
   - `NODE_ENV` = `production`
   - `DATABASE_URL` = (your Render DB internal connection string)
   - `JWT_SECRET` = (generate a strong random string)
   - `CLIENT_URL` = (your Render web service URL, e.g. https://your-app.onrender.com)

#### Seed Admin After Deploy
In Render shell or locally with production DATABASE_URL:
```bash
npm run seed
```

---

## Environment Variables Reference

| Variable | Description | Example |
|----------|-------------|---------|
| `PORT` | Server port | `5000` |
| `NODE_ENV` | Environment | `production` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://...` |
| `JWT_SECRET` | JWT signing secret (long random string) | `abc123...` |
| `UPLOAD_DIR` | File upload directory | `./server/uploads` |
| `CLIENT_URL` | Frontend URL for CORS | `https://yourapp.onrender.com` |
| `ADMIN_EMAIL` | Admin seed email | `admin@drbartender.com` |
| `ADMIN_PASSWORD` | Admin seed password | `ChangeMe123!` |

---

## File Upload Notes

- Files are stored locally at `./server/uploads/` in development
- On Render free tier, the filesystem is ephemeral — files are lost on redeploy
- **For production**, consider integrating:
  - **Cloudinary** (images/PDFs)
  - **AWS S3** or **Render Disk** (persistent storage)
  - **Backblaze B2** (cost-effective)

To add cloud storage, replace the `file.mv()` calls in `contractor.js` and `payment.js` with your cloud upload logic.

---

## Onboarding Flow

1. `/register` — Create account → auto-login → redirect to welcome
2. `/login` — Returning user login
3. `/welcome` — Intro + requirements overview
4. `/field-guide` — 10-section collapsible guide with acknowledgment checkbox
5. `/agreement` — Legal terms + non-solicitation + digital signature
6. `/contractor-profile` — Personal info, travel, equipment, file uploads
7. `/payday-protocols` — Pay rates, time expectations, W-9 upload, payment setup
8. `/complete` — Completion confirmation

---

## Admin Access

- URL: `/admin`
- Login with admin credentials
- View all contractors, filter by status
- Click any row to see full record
- Review uploads (click file links)
- View digital signature image
- Approve, mark reviewed, or deactivate

---

## Extending the Portal

This codebase is designed to be extended. Future additions could include:
- Staff portal with shift listings
- Email notifications (nodemailer or SendGrid)
- Calendar integration
- WhatsApp invite links
- Document generation (PDF contracts)
- Shift request/confirmation system
