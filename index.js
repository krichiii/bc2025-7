// ---------------------------------------------
// Load environment variables
// ---------------------------------------------
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const mysql = require('mysql2/promise');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const { v4: uuidv4 } = require('uuid');

// ---------------------------------------------
// CONFIG
// ---------------------------------------------
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const CACHE_DIR = process.env.CACHE_DIR || "./cache";

// ---------------------------------------------
// DB connection pool (MariaDB)
// ---------------------------------------------
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

// ---------------------------------------------
// Ensure cache directories exist
// ---------------------------------------------
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const PHOTOS_DIR = path.join(CACHE_DIR, "photos");
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

// ---------------------------------------------
// Express app
// ---------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------
// Multer (file upload)
// ---------------------------------------------
const storage = multer.diskStorage({
    destination: (_, __, cb) => cb(null, PHOTOS_DIR),
    filename: (_, file, cb) => {
        const ext = path.extname(file.originalname) || ".jpg";
        cb(null, uuidv4() + ext);
    }
});
const upload = multer({ storage });

// ---------------------------------------------
// Helper: check allowed methods
// ---------------------------------------------
function allowMethods(methods) {
    return (req, res, next) => {
        if (!methods.includes(req.method)) {
            res.set('Allow', methods.join(', '));
            return res.status(405).send('Method Not Allowed');
        }
        next();
    };
}

// ---------------------------------------------
// Static HTML forms
// ---------------------------------------------
app.get("/RegisterForm.html", (req, res) =>
    res.sendFile(path.join(process.cwd(), "RegisterForm.html"))
);

app.get("/SearchForm.html", (req, res) =>
    res.sendFile(path.join(process.cwd(), "SearchForm.html"))
);

// ---------------------------------------------
// API ENDPOINTS
// ---------------------------------------------

// REGISTER (POST /register)
app.post("/register", allowMethods(["POST"]), upload.single("photo"), async (req, res) => {
    const name = req.body.inventory_name;
    const desc = req.body.description || "";

    if (!name)
        return res.status(400).json({ error: "inventory_name is required" });

    const id = uuidv4();
    const photoFile = req.file ? req.file.filename : null;

    await pool.execute(
        "INSERT INTO inventory (id, name, description, photo_path) VALUES (?, ?, ?, ?)",
        [id, name, desc, photoFile]
    );

    res.status(201).json({
        id,
        name,
        description: desc,
        photo: photoFile ? `/inventory/${id}/photo` : null
    });
});

// GET ALL (GET /inventory)
app.get("/inventory", allowMethods(["GET"]), async (req, res) => {
    const [rows] = await pool.execute("SELECT * FROM inventory");

    const formatted = rows.map(r => ({
        id: r.id,
        name: r.name,
        description: r.description,
        photo: r.photo_path ? `/inventory/${r.id}/photo` : null
    }));

    res.json(formatted);
});

// GET BY ID (GET /inventory/:id)
app.get("/inventory/:id", allowMethods(["GET"]), async (req, res) => {
    const id = req.params.id;

    const [rows] = await pool.execute(
        "SELECT * FROM inventory WHERE id = ?",
        [id]
    );

    if (rows.length === 0)
        return res.status(404).send("Not found");

    const item = rows[0];

    res.json({
        id: item.id,
        name: item.name,
        description: item.description,
        photo: item.photo_path ? `/inventory/${item.id}/photo` : null
    });
});

// UPDATE (PUT /inventory/:id)
app.put("/inventory/:id", allowMethods(["PUT"]), async (req, res) => {
    const id = req.params.id;

    const [rows] = await pool.execute(
        "SELECT * FROM inventory WHERE id = ?", [id]
    );
    if (rows.length === 0)
        return res.status(404).send("Not found");

    const name = req.body.name || rows[0].name;
    const description = req.body.description || rows[0].description;

    await pool.execute(
        "UPDATE inventory SET name = ?, description = ? WHERE id = ?",
        [name, description, id]
    );

    res.json({
        id,
        name,
        description,
        photo: rows[0].photo_path ? `/inventory/${id}/photo` : null
    });
});

// GET PHOTO (GET /inventory/:id/photo)
app.get("/inventory/:id/photo", allowMethods(["GET"]), async (req, res) => {
    const id = req.params.id;

    const [rows] = await pool.execute(
        "SELECT photo_path FROM inventory WHERE id = ?",
        [id]
    );

    if (rows.length === 0 || !rows[0].photo_path)
        return res.status(404).send("Not found");

    const file = path.join(PHOTOS_DIR, rows[0].photo_path);
    if (!fs.existsSync(file))
        return res.status(404).send("Not found");

    res.set("Content-Type", "image/jpeg");
    fs.createReadStream(file).pipe(res);
});

// UPDATE PHOTO (PUT /inventory/:id/photo)
app.put("/inventory/:id/photo", allowMethods(["PUT"]), upload.single("photo"), async (req, res) => {
    const id = req.params.id;

    const [rows] = await pool.execute(
        "SELECT photo_path FROM inventory WHERE id = ?",
        [id]
    );
    if (rows.length === 0)
        return res.status(404).send("Not found");

    const oldPhoto = rows[0].photo_path;

    if (!req.file)
        return res.status(400).send("No file uploaded");

    if (oldPhoto) {
        const oldFile = path.join(PHOTOS_DIR, oldPhoto);
        if (fs.existsSync(oldFile))
            fs.unlinkSync(oldFile);
    }

    await pool.execute(
        "UPDATE inventory SET photo_path = ? WHERE id = ?",
        [req.file.filename, id]
    );

    res.json({
        id,
        photo: `/inventory/${id}/photo`
    });
});

// DELETE (DELETE /inventory/:id)
app.delete("/inventory/:id", allowMethods(["DELETE"]), async (req, res) => {
    const id = req.params.id;

    const [rows] = await pool.execute(
        "SELECT photo_path FROM inventory WHERE id = ?",
        [id]
    );
    if (rows.length === 0)
        return res.status(404).send("Not found");

    const photo = rows[0].photo_path;

    if (photo) {
        const p = path.join(PHOTOS_DIR, photo);
        if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    await pool.execute("DELETE FROM inventory WHERE id = ?", [id]);

    res.json({ message: "Deleted" });
});

// SEARCH (POST /search)
app.post("/search", allowMethods(["POST"]), async (req, res) => {
    const id = req.body.id;
    const hasPhoto = req.body.has_photo;

    if (!id) return res.status(400).send("id required");

    const [rows] = await pool.execute(
        "SELECT * FROM inventory WHERE id = ?",
        [id]
    );
    if (rows.length === 0) return res.status(404).send("Not found");

    const item = rows[0];
    let description = item.description;

    if (hasPhoto && item.photo_path)
        description += ` Photo: /inventory/${id}/photo`;

    res.json({
        id: item.id,
        name: item.name,
        description
    });
});

// ---------------------------------------------
// Swagger setup
// ---------------------------------------------
const swaggerDefinition = {
    openapi: "3.0.0",
    info: {
        title: "Inventory Service API",
        version: "1.0.0",
        description: "API documentation for Inventory Lab #6 (MariaDB)"
    },
    servers: [
        { url: `http://localhost:${PORT}` }
    ]
};

const swaggerOptions = {
    swaggerDefinition,
    apis: ["./swagger/*.yaml"]
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ---------------------------------------------
// Start HTTP server
// ---------------------------------------------
const server = http.createServer(app);

server.listen(PORT, HOST, () => {
    console.log(`Server running at http://${HOST}:${PORT}`);
    console.log("MariaDB connected at:", process.env.DB_HOST);
});


// placeholder test