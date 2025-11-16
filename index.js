const express = require("express");
const cors = require("cors");
const db = require("./db");
const app = express();

const http = require("http").createServer(app);
const { Server } = require("socket.io");

const io = new Server(http, {
  cors: {
    origin: "*",
  },
});

app.use(cors());
app.use(express.json());

// ======================================
// ROUTES CLASSIQUES (inchangées)
// ======================================
app.get("/", (req, res) => {
  res.json({ message: "Backend OK" });
});

app.post("/api/player", (req, res) => {
  const { firstName, lastName } = req.body;
  if (!firstName || !lastName) {
    return res.status(400).json({ error: "Nom et prénom requis" });
  }

  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO players (firstName, lastName, createdAt)
    VALUES (?, ?, ?)
  `);

  const result = stmt.run(firstName, lastName, now);

  res.json({
    id: result.lastInsertRowid,
    firstName,
    lastName,
    createdAt: now,
  });
});

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

app.post("/api/room/create", (req, res) => {
  const { playerId } = req.body;

  if (!playerId) return res.status(400).json({ error: "playerId requis" });

  let code = generateRoomCode();
  const check = db.prepare("SELECT * FROM rooms WHERE code = ?");
  while (check.get(code)) code = generateRoomCode();

  const now = new Date().toISOString();

  const roomStmt = db.prepare(`
    INSERT INTO rooms (code, ownerId, createdAt)
    VALUES (?, ?, ?)
  `);

  const roomResult = roomStmt.run(code, playerId, now);

  db.prepare(`
    INSERT INTO room_players (playerId, roomId, isOwner, joinedAt)
    VALUES (?, ?, 1, ?)
  `).run(playerId, roomResult.lastInsertRowid, now);

  res.json({ roomId: roomResult.lastInsertRowid, code, ownerId: playerId });
});

app.post("/api/room/join", (req, res) => {
  const { playerId, code } = req.body;

  if (!playerId || !code)
    return res.status(400).json({ error: "playerId et code requis" });

  const room = db.prepare("SELECT * FROM rooms WHERE code = ?").get(code);
  if (!room) return res.status(404).json({ error: "Salon introuvable" });

  const now = new Date().toISOString();

  const exists = db
    .prepare("SELECT * FROM room_players WHERE playerId = ? AND roomId = ?")
    .get(playerId, room.id);

  if (!exists) {
    db.prepare(`
      INSERT INTO room_players (playerId, roomId, isOwner, joinedAt)
      VALUES (?, ?, 0, ?)
    `).run(playerId, room.id, now);
  }

  res.json({
    roomId: room.id,
    code: room.code,
    ownerId: room.ownerId,
  });
});

app.get("/api/room/players/:code", (req, res) => {
  const { code } = req.params;

  const room = db.prepare("SELECT * FROM rooms WHERE code = ?").get(code);
  if (!room) return res.status(404).json({ error: "Room not found" });

  const players = db
    .prepare(`
      SELECT players.id, firstName, lastName
      FROM room_players
      JOIN players ON players.id = room_players.playerId
      WHERE room_players.roomId = ?
    `)
    .all(room.id);

  res.json({ players, ownerId: room.ownerId });
});

// ======================================
// QUESTIONS (correctIndex FIXÉ)
// ======================================
const QUESTIONS = [
  {
    questionText: "À quoi sert ce logiciel (VScode) ?",
    imageUrl: "/questions/vscode.png",
    answers: ["Orienté HTML", "Héberger", "Maintenance", "Développer"],
    correctIndex: 3,
  },
  {
    questionText: "À quoi correspond ce logo ?",
    imageUrl: "/questions/logohtml.png",
    answers: ["Yell5", "HTML", "JetBrains", "SQL"],
    correctIndex: 1,
  },
  {
    questionText: "À quoi correspond ce logo ?",
    imageUrl: "/questions/logocss.png",
    answers: ["CSS", "Node.js", "TScript", "BlueStack"],
    correctIndex: 0,
  },
  {
    questionText: "À quoi correspond ce logo ?",
    imageUrl: "/questions/logojs.png",
    answers: ["JSite", "Ruby", "JavaScript", "PHP"],
    correctIndex: 2,
  },
  {
    questionText: "À quoi correspond ce logo ?",
    imageUrl: "/questions/logopy.png",
    answers: ["Reverze", "Vercel", "Snake", "Python"],
    correctIndex: 3,
  },
  {
    questionText: "Où dois-je écrire mon code ?",
    imageUrl: "/questions/code.png",
    answers: ["Title", "html", "Body", "Head"],
    correctIndex: 2,
  },
];

// ======================================
// SOCKET : SYNCHRONISATION
// ======================================
const ROOM_STATES = {};

io.on("connection", (socket) => {
  console.log("Socket connecté :", socket.id);

  socket.on("joinRoom", (roomCode) => {
    socket.join(roomCode);
  });

  socket.on("startGame", (roomCode) => {
    startQuiz(roomCode);
  });

  socket.on("answer", ({ roomCode, chosenIndex, playerId }) => {
    const state = ROOM_STATES[roomCode];
    if (!state) return;

    const q = QUESTIONS[state.questionIndex];

    if (chosenIndex === q.correctIndex) state.score++;

    io.to(roomCode).emit("answerResult", {
      correctIndex: q.correctIndex,
      chosenIndex,
    });
  });
});

// ======================================
// LANCER LE QUIZ
// ======================================
async function startQuiz(roomCode) {
  const room = db.prepare("SELECT * FROM rooms WHERE code = ?").get(roomCode);
  const players = db
    .prepare(`
        SELECT players.id, firstName, lastName
        FROM room_players
        JOIN players ON players.id = room_players.playerId
        WHERE room_players.roomId = ?
      `)
    .all(room.id);

  ROOM_STATES[roomCode] = {
    questionIndex: 0,
    score: 0,
    players,
  };

  // Écran de chargement
  io.to(roomCode).emit("phase", {
    type: "LOADING",
    duration: 1500,
    startTime: Date.now(),
  });

  await wait(1500);

  io.to(roomCode).emit("gameStart");
  runQuiz(roomCode);
}

// ======================================
// BOUCLE DES QUESTIONS (VERSION STABLE)
// ======================================
async function runQuiz(roomCode) {
  const state = ROOM_STATES[roomCode];

  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i];
    state.questionIndex = i;

    // —— 1) PHASE DE CHARGEMENT POUR LA QUESTION
    io.to(roomCode).emit("phase", {
      type: "LOADING",
      questionIndex: i,
      duration: 800,
      startTime: Date.now(),
    });

    // Temps pour précharger l'image
    await wait(800);

    // —— 2) ENVOYER LA QUESTION
    io.to(roomCode).emit("questionData", {
      questionText: q.questionText,
      imageUrl: q.imageUrl,
      answers: q.answers,
    });

    // Petite pause pour que React affiche la question
    await wait(50);

    // —— 3) LANCER LA PHASE THINK
    io.to(roomCode).emit("phase", {
      type: "THINK",
      questionIndex: i,
      duration: 10000,
      startTime: Date.now(),
    });


    await wait(10000);

    // 3) Phase : ANSWER
    const responder = state.players[i % state.players.length];

    io.to(roomCode).emit("phase", {
      type: "ANSWER",
      questionIndex: i,
      activePlayerId: responder.id,
      activePlayerName: responder.firstName,
      duration: 20000,
      startTime: Date.now(),
    });

    await wait(20000);

    // 4) Phase : RESULT
    io.to(roomCode).emit("phase", {
      type: "RESULT",
      questionIndex: i,
      correctIndex: q.correctIndex,
      duration: 5000,
      startTime: Date.now(),
    });

    await wait(5000);
  }

  io.to(roomCode).emit("quizEnd", {
    score: state.score,
    success: state.score >= 4,
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ======================================
http.listen(4000, () =>
  console.log(`Backend lancé sur http://localhost:4000`)
);
