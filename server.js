require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS
    }
});

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

app.use('/uploads', express.static(uploadDir));

const db = mysql.createPool({
    host: process.env.DB_HOST || process.env.MYSQLHOST,
    user: process.env.DB_USER || process.env.MYSQLUSER,
    password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD,
    database: process.env.DB_NAME || process.env.MYSQLDATABASE,
    port: process.env.DB_PORT || process.env.MYSQLPORT || 3306,
    timezone: '-03:00',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

db.getConnection((err, connection) => {
    if (err) {
        console.error('Error conectando a MySQL:', err);
        return;
    }
    console.log('Conectado exitosamente a la base de datos MySQL.');
    connection.release();
});

function getLocalDateStr(offsetMinutes = -180) {
    const now = new Date();
    const localTime = new Date(now.getTime() + (offsetMinutes + now.getTimezoneOffset()) * 60000);
    const yyyy = localTime.getFullYear();
    const mm = String(localTime.getMonth() + 1).padStart(2, '0');
    const dd = String(localTime.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

// ==========================================
// 1. REGISTRO DE USUARIOS
// ==========================================
app.post('/api/registro', upload.single('credencial'), (req, res) => {
    const { username, email, password, rol } = req.body;
    const matricula = req.body.matricula || null;
    const credencialPath = req.file ? req.file.filename : null;
    const estadoCuenta = (rol === 'profesional') ? 'pendiente' : 'activo';
    const avatarPorDefecto = '🧒🏽';

    if (!username || !email || !password || !rol) {
        return res.status(400).json({ mensaje: 'Todos los campos obligatorios deben completarse.' });
    }

    const sql = 'INSERT INTO usuarios (username, email, password, rol, matricula, credencial, estado_cuenta, avatar) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

    db.query(sql, [username.trim(), email.trim(), password, rol, matricula, credencialPath, estadoCuenta, avatarPorDefecto], (err, result) => {
        if (err) {
            console.error('Error en registro:', err);
            return res.status(500).json({ mensaje: 'El correo o usuario ya está registrado o hubo un error en la BD.' });
        }

        if (rol === 'profesional') {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            const mailOptionsAdmin = {
                from: process.env.MAIL_USER,
                to: process.env.MAIL_USER,
                subject: '¡Nueva solicitud de profesional en Xpressa+!',
                html: `
                    <div style="font-family: sans-serif; color: #333;">
                        <h2>Nueva solicitud de registro</h2>
                        <p>El fonoaudiólogo <b>${username}</b> (${email}) con matrícula <b>${matricula}</b> solicitó acceso.</p>
                        <p>Para autorizarlo y habilitar su inicio de sesión, haz clic en el siguiente botón:</p>
                        <br>
                        <a href="${baseUrl}/api/aprobar-link/${result.insertId}" style="padding: 12px 24px; background-color: #10B981; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">✅ Autorizar Profesional</a>
                    </div>
                `
            };
            transporter.sendMail(mailOptionsAdmin, (errorEmail) => {
                if (errorEmail) console.error('Error avisando al administrador:', errorEmail);
            });
        }

        res.status(201).json({ mensaje: '¡Usuario registrado con éxito!', id: result.insertId });
    });
});

// ==========================================
// 2. INICIO DE SESIÓN (Con validaciones y Racha)
// ==========================================
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ mensaje: 'Por favor ingresa usuario y contraseña.' });
    }

    const sql = 'SELECT * FROM usuarios WHERE username = ? AND password = ?';
    db.query(sql, [username.trim(), password], (err, results) => {
        if (err) return res.status(500).json({ mensaje: 'Error en el servidor.' });
        if (results.length === 0) return res.status(401).json({ mensaje: 'Usuario o contraseña incorrectos.' });

        const usuario = results[0];

        if (usuario.rol === 'profesional' && usuario.estado_cuenta === 'pendiente') {
            return res.status(403).json({ mensaje: 'Tu cuenta está en revisión. Te avisaremos cuando se habilite tu permiso.' });
        }

        if (usuario.rol === 'paciente') {
            const hoyLocal = getLocalDateStr();
            const updateSql = `
                UPDATE usuarios 
                SET 
                    dias_racha = CASE 
                        WHEN fecha_ultimo_juego IS NULL THEN 1
                        WHEN DATEDIFF(?, fecha_ultimo_juego) = 1 THEN dias_racha + 1
                        WHEN DATEDIFF(?, fecha_ultimo_juego) > 1 THEN 1
                        ELSE dias_racha
                    END,
                    fecha_ultimo_juego = ?
                WHERE id = ?
            `;
            db.query(updateSql, [hoyLocal, hoyLocal, hoyLocal, usuario.id], (errUpdate) => {
                if (errUpdate) console.error('Error actualizando racha:', errUpdate);
            });
        }

        res.json({
            id: usuario.id,
            username: usuario.username,
            rol: usuario.rol,
            es_primer_ingreso: usuario.es_primer_ingreso !== undefined ? usuario.es_primer_ingreso : 1
        });
    });
});

// ==========================================
// 3. RECLAMAR REGALO DIARIO
// ==========================================
app.post('/api/reclamar-regalo', (req, res) => {
    const usuario_id = parseInt(req.body.usuario_id, 10);
    if (isNaN(usuario_id)) return res.status(400).json({ mensaje: 'ID de usuario inválido.' });

    const sql = 'SELECT estrellas, DATE_FORMAT(fecha_ultimo_regalo, "%Y-%m-%d") as fecha_regalo_str FROM usuarios WHERE id = ?';

    db.query(sql, [usuario_id], (err, results) => {
        if (err || results.length === 0) return res.status(500).json({ mensaje: 'Error al buscar usuario.' });

        const usuario = results[0];
        const hoyStr = getLocalDateStr();

        if (usuario.fecha_regalo_str === hoyStr) {
            return res.status(400).json({ mensaje: 'Ya reclamaste tu regalo de hoy. ¡Vuelve mañana!' });
        }

        const nuevasEstrellas = (usuario.estrellas || 0) + 10;
        const updateSql = 'UPDATE usuarios SET estrellas = ?, fecha_ultimo_regalo = ? WHERE id = ?';

        db.query(updateSql, [nuevasEstrellas, hoyStr, usuario_id], (errUpdate) => {
            if (errUpdate) return res.status(500).json({ mensaje: 'Error al guardar el regalo.' });
            res.json({ mensaje: '¡Ganaste 10 estrellas!', estrellas: nuevasEstrellas });
        });
    });
});

// ==========================================
// 4. APROBAR PROFESIONAL DESDE EL CORREO
// ==========================================
app.get('/api/aprobar-link/:id', (req, res) => {
    const profesionalId = parseInt(req.params.id, 10);
    if (isNaN(profesionalId)) return res.send('<h1 style="color: red; text-align: center;">ID inválido.</h1>');

    const sqlUpdate = "UPDATE usuarios SET estado_cuenta = 'activo' WHERE id = ? AND rol = 'profesional'";

    db.query(sqlUpdate, [profesionalId], (err, result) => {
        if (err || result.affectedRows === 0) {
            return res.send('<h1 style="color: red; text-align: center;">Error: Profesional no encontrado o ya aprobado.</h1>');
        }

        const sqlEmail = 'SELECT email, username FROM usuarios WHERE id = ?';
        db.query(sqlEmail, [profesionalId], (errEmail, results) => {
            if (errEmail || results.length === 0) return res.send('<h1>Aprobado, pero sin correo.</h1>');

            const profesional = results[0];
            const mailOptions = {
                from: process.env.MAIL_USER,
                to: profesional.email,
                subject: '¡Tu cuenta en Xpressa+ ha sido autorizada! 🎉',
                html: `
                    <div style="font-family: sans-serif; color: #333; text-align: center;">
                        <h2 style="color: #3B82F6;">¡Hola, ${profesional.username}!</h2>
                        <p>Tu cuenta en <b>Xpressa+</b> ha sido autorizada.</p>
                        <p>Ya tienes el acceso habilitado. Puedes ir a la aplicación e iniciar sesión con tu contraseña.</p>
                    </div>
                `
            };

            transporter.sendMail(mailOptions, () => {
                res.send('<div style="text-align: center; font-family: sans-serif; margin-top: 50px;"><h1 style="color: #10B981;">✅ ¡Profesional autorizado con éxito!</h1><p>Se le ha enviado un correo avisándole que ya puede iniciar sesión.</p></div>');
            });
        });
    });
});

// ==========================================
// 5. OBTENER PERFIL
// ==========================================
app.get('/api/perfil/:id', (req, res) => {
    const usuarioId = parseInt(req.params.id, 10);
    if (isNaN(usuarioId)) return res.status(400).json({ mensaje: 'ID inválido.' });

    const sql = `
        SELECT u.id, u.username, u.rol, u.avatar, u.fonoaudiologo_id, u.dias_racha, u.estrellas, 
               DATE_FORMAT(u.fecha_ultimo_regalo, "%Y-%m-%d") as fecha_ultimo_regalo_str,
               p.nombre, p.apellido, p.dni, p.edad, p.sexo 
        FROM usuarios u 
        LEFT JOIN perfiles p ON u.id = p.usuario_id 
        WHERE u.id = ?
    `;

    db.query(sql, [usuarioId], (err, results) => {
        if (err || results.length === 0) {
            return res.status(404).json({ mensaje: 'Perfil no encontrado.' });
        }
        res.json(results[0]);
    });
});

// ==========================================
// 6. GUARDAR O ACTUALIZAR DATOS DE PERFIL
// ==========================================
app.post('/api/perfil', (req, res) => {
    const usuario_id = parseInt(req.body.usuario_id, 10);
    const { nombre, apellido, dni, edad, sexo, avatar } = req.body;

    if (isNaN(usuario_id)) {
        return res.status(400).json({ mensaje: 'ID de usuario inválido o no proporcionado.' });
    }

    const sqlPerfil = `
        INSERT INTO perfiles (usuario_id, nombre, apellido, dni, edad, sexo, avatar) 
        VALUES (?, ?, ?, ?, ?, ?, ?) 
        ON DUPLICATE KEY UPDATE 
        nombre = VALUES(nombre), 
        apellido = VALUES(apellido), 
        dni = VALUES(dni), 
        edad = VALUES(edad), 
        sexo = VALUES(sexo),
        avatar = VALUES(avatar)
    `;

    db.query(sqlPerfil, [usuario_id, nombre, apellido, dni, edad, sexo, avatar], (err) => {
        if (err) {
            console.error('Error al guardar perfil:', err);
            return res.status(500).json({ mensaje: 'Error al guardar los datos en la base de datos.' });
        }
        res.json({ mensaje: 'Perfil guardado con éxito.' });
    });
});

// ==========================================
// 7. ACTUALIZAR SOLO EL AVATAR
// ==========================================
app.post('/api/avatar', (req, res) => {
    const usuario_id = parseInt(req.body.usuario_id, 10);
    const { avatar } = req.body;

    if (isNaN(usuario_id) || !avatar) {
        return res.status(400).json({ mensaje: 'Faltan datos válidos.' });
    }

    const sqlUsuarios = 'UPDATE usuarios SET avatar = ? WHERE id = ?';
    const sqlPerfiles = `
        INSERT INTO perfiles (usuario_id, avatar) VALUES (?, ?) 
        ON DUPLICATE KEY UPDATE avatar = VALUES(avatar)
    `;

    db.query(sqlUsuarios, [avatar, usuario_id], () => {
        db.query(sqlPerfiles, [usuario_id, avatar], (err) => {
            if (err) {
                console.error('Error al actualizar avatar:', err);
                return res.status(500).json({ mensaje: 'Error al actualizar el avatar.' });
            }
            res.json({ mensaje: 'Avatar actualizado con éxito.' });
        });
    });
});

// ==========================================
// 8. VINCULACIÓN CON FONOAUDIÓLOGO (Validada)
// ==========================================
app.post('/api/vincular', (req, res) => {
    const paciente_id = parseInt(req.body.paciente_id, 10);
    const { codigo } = req.body;

    if (isNaN(paciente_id) || !codigo || typeof codigo !== 'string') {
        return res.status(400).json({ mensaje: 'Datos de vinculación incompletos o inválidos.' });
    }

    const partes = codigo.trim().toUpperCase().split('-');
    if (partes.length !== 2 || partes[0] !== 'XPR') {
        return res.status(400).json({ mensaje: 'Formato de código inválido. Debe ser XPR-Número.' });
    }

    const profesionalId = parseInt(partes[1], 10);
    if (isNaN(profesionalId) || profesionalId <= 0) {
        return res.status(400).json({ mensaje: 'El identificador del especialista debe ser numérico.' });
    }

    const checkSql = "SELECT id FROM usuarios WHERE id = ? AND rol = 'profesional' AND estado_cuenta = 'activo'";
    db.query(checkSql, [profesionalId], (errCheck, resCheck) => {
        if (errCheck) return res.status(500).json({ mensaje: 'Error verificando especialista.' });
        if (resCheck.length === 0) return res.status(404).json({ mensaje: 'No se encontró un especialista activo con ese código.' });

        const sql = 'UPDATE usuarios SET fonoaudiologo_id = ? WHERE id = ?';
        db.query(sql, [profesionalId, paciente_id], (err) => {
            if (err) {
                console.error('Error al vincular:', err);
                return res.status(500).json({ mensaje: 'Error al procesar la vinculación.' });
            }
            res.json({ mensaje: '¡Vinculación exitosa!' });
        });
    });
});

// ==========================================
// 9. GUARDAR Y OBTENER LETRAS
// ==========================================
app.post('/api/guardar-letras', (req, res) => {
    const usuario_id = parseInt(req.body.usuario_id, 10);
    const { letras } = req.body;

    if (isNaN(usuario_id) || !Array.isArray(letras)) {
        return res.status(400).json({ mensaje: 'Faltan datos obligatorios.' });
    }

    const letrasJson = JSON.stringify(letras);
    const cantidadMochila = letras.length;

    const sqlConfig = `
        INSERT INTO configuracion_letras (usuario_id, letras_seleccionadas, cantidad_mochila) 
        VALUES (?, ?, ?) 
        ON DUPLICATE KEY UPDATE 
        letras_seleccionadas = VALUES(letras_seleccionadas), 
        cantidad_mochila = VALUES(cantidad_mochila)
    `;

    db.query(sqlConfig, [usuario_id, letrasJson, cantidadMochila], (err) => {
        if (err) return res.status(500).json({ mensaje: 'Error al guardar las letras.' });

        const sqlUser = 'UPDATE usuarios SET es_primer_ingreso = 0 WHERE id = ?';
        db.query(sqlUser, [usuario_id], () => {
            res.json({ mensaje: 'Letras guardadas con éxito.' });
        });
    });
});

app.get('/api/obtener-letras', (req, res) => {
    const usuario_id = parseInt(req.query.usuario_id, 10);
    if (isNaN(usuario_id)) return res.status(400).json({ mensaje: 'Falta el ID de usuario válido.' });

    const sql = 'SELECT letras_seleccionadas FROM configuracion_letras WHERE usuario_id = ?';
    db.query(sql, [usuario_id], (err, results) => {
        if (err || results.length === 0) return res.json({ letras: [] });

        let letras = [];
        try { letras = JSON.parse(results[0].letras_seleccionadas); } catch (e) { letras = []; }
        res.json({ letras });
    });
});

// ==========================================
// 10. PACIENTES, TOKEN, ACTIVIDADES Y ESTADÍSTICAS
// ==========================================
app.get('/api/pacientes/:fono_id', (req, res) => {
    const fonoId = parseInt(req.params.fono_id, 10);
    if (isNaN(fonoId)) return res.status(400).json({ mensaje: 'ID inválido.' });

    const sql = `
        SELECT u.id, u.username, u.dias_racha, u.estrellas, u.fecha_ultimo_juego,
               p.nombre, p.apellido, p.avatar 
        FROM usuarios u 
        LEFT JOIN perfiles p ON u.id = p.usuario_id 
        WHERE u.fonoaudiologo_id = ? AND u.rol = 'paciente'
    `;
    db.query(sql, [fonoId], (err, results) => {
        if (err) return res.status(500).json({ mensaje: 'Error interno del servidor.' });
        res.json(results);
    });
});

app.get('/api/fonoaudiologo/token/:id', (req, res) => {
    const fonoId = parseInt(req.params.id, 10);
    if (isNaN(fonoId)) return res.status(400).json({ mensaje: 'ID inválido.' });
    res.json({ token: `XPR-${fonoId}` });
});

app.post('/api/asignar-tarea', upload.single('foto'), (req, res) => {
    const paciente_id = parseInt(req.body.paciente_id, 10);
    const profesional_id = req.body.profesional_id ? parseInt(req.body.profesional_id, 10) : null;
    const { descripcion } = req.body;
    const fotoPath = req.file ? req.file.filename : null;

    if (isNaN(paciente_id) || !descripcion) {
        return res.status(400).json({ mensaje: 'Faltan datos obligatorios.' });
    }

    const sql = `
        INSERT INTO actividades (profesional_id, paciente_id, foto_path, consigna, estado, fecha_envio) 
        VALUES (?, ?, ?, ?, 'pendiente', NOW())
    `;
    db.query(sql, [profesional_id, paciente_id, fotoPath, descripcion], (err, result) => {
        if (err) return res.status(500).json({ mensaje: 'Error al guardar la actividad.' });
        res.status(201).json({ mensaje: '¡Actividad asignada con éxito!', id: result.insertId });
    });
});

app.get('/api/actividades/:paciente_id', (req, res) => {
    const pacienteId = parseInt(req.params.paciente_id, 10);
    if (isNaN(pacienteId)) return res.status(400).json({ mensaje: 'ID inválido.' });

    const sql = `
        SELECT a.*, u.username AS fonoaudiologo_nombre 
        FROM actividades a
        LEFT JOIN usuarios u ON a.profesional_id = u.id
        WHERE a.paciente_id = ? AND a.estado = 'pendiente'
        ORDER BY a.fecha_envio DESC
        LIMIT 1
    `;
    db.query(sql, [pacienteId], (err, results) => {
        if (err) return res.status(500).json({ mensaje: 'Error al consultar actividades.' });
        res.json({ tarea: results.length > 0 ? results[0] : null });
    });
});

app.put('/api/actividades/:id/completar', (req, res) => {
    const actividadId = parseInt(req.params.id, 10);
    if (isNaN(actividadId)) return res.status(400).json({ mensaje: 'ID inválido.' });

    const sql = "UPDATE actividades SET estado = 'completada' WHERE id = ?";
    db.query(sql, [actividadId], (err) => {
        if (err) return res.status(500).json({ mensaje: 'Error al actualizar la tarea.' });
        res.json({ mensaje: 'Tarea completada exitosamente.' });
    });
});

app.post('/api/progreso', (req, res) => {
    const paciente_id = parseInt(req.body.paciente_id, 10);
    const { juego, fonema, aciertos, errores, tiempo_segundos } = req.body;

    if (isNaN(paciente_id) || !juego || !fonema) {
        return res.status(400).json({ mensaje: 'Datos de progreso incompletos.' });
    }

    const sql = `
        INSERT INTO progresos_juegos (paciente_id, juego, fonema, aciertos, errores, tiempo_segundos) 
        VALUES (?, ?, ?, ?, ?, ?)
    `;
    db.query(sql, [paciente_id, juego, fonema, aciertos || 0, errores || 0, tiempo_segundos || 0], (err) => {
        if (err) return res.status(500).json({ mensaje: 'Error de la base de datos.' });
        res.status(201).json({ mensaje: 'Progreso guardado.' });
    });
});

app.get('/api/estadisticas/:paciente_id', (req, res) => {
    const pacienteId = parseInt(req.params.paciente_id, 10);
    if (isNaN(pacienteId)) return res.status(400).json({ mensaje: 'ID inválido.' });

    const sqlStats = `
        SELECT 
            fonema,
            SUM(aciertos) as total_aciertos,
            SUM(aciertos + errores) as total_intentos,
            SUM(tiempo_segundos) as tiempo_total,
            (SELECT juego FROM progresos_juegos WHERE paciente_id = ? AND fecha >= DATE_SUB(NOW(), INTERVAL 7 DAY) GROUP BY juego ORDER BY COUNT(*) DESC LIMIT 1) as juego_favorito
        FROM progresos_juegos
        WHERE paciente_id = ? AND fecha >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        GROUP BY fonema
    `;
    const sqlLetras = 'SELECT letras_seleccionadas FROM configuracion_letras WHERE usuario_id = ?';

    db.query(sqlStats, [pacienteId, pacienteId], (errStats, resultadosStats) => {
        if (errStats) return res.status(500).json({ mensaje: 'Error calculando estadísticas.' });

        db.query(sqlLetras, [pacienteId], (errLetras, resultadosLetras) => {
            if (errLetras) return res.status(500).json({ mensaje: 'Error obteniendo letras.' });

            let letrasActivas = [];
            if (resultadosLetras.length > 0) {
                try { letrasActivas = JSON.parse(resultadosLetras[0].letras_seleccionadas); } catch (e) {}
            }
            res.json({ estadisticas: resultadosStats, letras_activas: letrasActivas });
        });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor backend corriendo en puerto ${PORT}`);
});

