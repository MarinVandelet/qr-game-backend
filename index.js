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
// TEST
// ======================================
app.get("/", (req, res) => {
  res.json({ message: "Backend OK" });
});

// ======================================
// ROUTE : Création d’un joueur
// ======================================
app.post("/api/player", (req, res) => {
  const { firstName, lastName } = req.body;

  if (!firstName || !lastName) {
    return res.status(400).json({ error: "Nom et prénom requis" });
  }

  const now = new Date().toISOString();

  const stmt = db.prepare(
    `INSERT INTO players (firstName, lastName, createdAt)
     VALUES (?, ?, ?)`
  );

  const result = stmt.run(firstName, lastName, now);

  res.json({
    id: result.lastInsertRowid,
    firstName,
    lastName,
    createdAt: now,
  });
});

// ======================================
// UTILITAIRE : Génération de code salon
// ======================================
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

// ======================================
// ROUTE : Créer un salon
// ======================================
app.post("/api/room/create", (req, res) => {
  const { playerId } = req.body;

  if (!playerId) {
    return res.status(400).json({ error: "playerId requis" });
  }

  let code = generateRoomCode();

  const checkStmt = db.prepare("SELECT * FROM rooms WHERE code = ?");
  while (checkStmt.get(code)) {
    code = generateRoomCode();
  }

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

  res.json({
    roomId: roomResult.lastInsertRowid,
    code,
    ownerId: playerId,
  });
});

// ======================================
// ROUTE : Rejoindre un salon
// ======================================
app.post("/api/room/join", (req, res) => {
  const { playerId, code } = req.body;

  if (!playerId || !code) {
    return res.status(400).json({ error: "playerId et code sont requis" });
  }

  const room = db.prepare("SELECT * FROM rooms WHERE code = ?").get(code);

  if (!room) {
    return res.status(404).json({ error: "Salon introuvable" });
  }

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

// ======================================
// ROUTE : Liste des joueurs d’un salon
// ======================================
app.get("/api/room/players/:code", (req, res) => {
  const { code } = req.params;

  const room = db.prepare("SELECT * FROM rooms WHERE code = ?").get(code);

  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  const players = db
    .prepare(
      `
      SELECT players.id, firstName, lastName
      FROM room_players
      JOIN players ON players.id = room_players.playerId
      WHERE room_players.roomId = ?
    `
    )
    .all(room.id);

  res.json({
    players,
    ownerId: room.ownerId,
  });
});

// ======================================
// QUESTIONS GAME 1 (tu peux les modifier)
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
// ÉPREUVE 2 : QR & indices
// ======================================
const GAME2_QR = [
  { id: "QR1-316", hint: "Le QR code est sous une table." },
  { id: "QR2-316", hint: "Le QR code est derrière une chaise." },
  { id: "QR3-316", hint: "Le QR code est près du tableau." },
  { id: "QR4-316", hint: "Le QR code est proche de la fenêtre." },
];

// ======================================
// SOCKET.IO : GAME 1 + GAME 2
// ======================================
const ROOM_STATES = {}; // { [roomCode]: { players, quiz: {...}, game2: {...} } }

io.on("connection", (socket) => {
  console.log("Socket connecté :", socket.id);

  socket.on("joinRoom", (roomCode) => {
    socket.join(roomCode);
    console.log(`Socket ${socket.id} a rejoint le salon ${roomCode}`);
  });

  // Lancer le QUIZ (Game 1)
  socket.on("startGame", (roomCode) => {
    startQuiz(roomCode);
  });

  // Réponse à une question du quiz
  socket.on("answer", ({ roomCode, chosenIndex, playerId }) => {
    const state = ROOM_STATES[roomCode];
    if (!state || !state.quiz) return;

    const qIndex = state.quiz.questionIndex;
    const q = QUESTIONS[qIndex];

    if (chosenIndex === q.correctIndex) {
      state.quiz.score++;
    }

    io.to(roomCode).emit("answerResult", {
      correctIndex: q.correctIndex,
      chosenIndex,
    });
  });

  // Lancer l'épreuve 2
  socket.on("startGame2", (roomCode) => {
    startGame2(roomCode);
  });
});

// ======================================
// GAME 1 : QUIZ
// ======================================
async function startQuiz(roomCode) {
  // On récupère les joueurs du salon
  const room = db.prepare("SELECT * FROM rooms WHERE code = ?").get(roomCode);

  const players = db
    .prepare(
      `
      SELECT players.id, firstName, lastName
      FROM room_players
      JOIN players ON players.id = room_players.playerId
      WHERE room_players.roomId = ?
    `
    )
    .all(room.id);

  // On garde les joueurs en mémoire pour game 1 + game 2
  ROOM_STATES[roomCode] = ROOM_STATES[roomCode] || {};
  ROOM_STATES[roomCode].players = players;
  ROOM_STATES[roomCode].quiz = {
    questionIndex: 0,
    score: 0,
  };

  // Petite phase loading au début du quiz
  io.to(roomCode).emit("phase", {
    type: "LOADING",
    duration: 1500,
    startTime: Date.now(),
  });

  await wait(1500);

  io.to(roomCode).emit("gameStart");

  runQuiz(roomCode);
}

async function runQuiz(roomCode) {
  const state = ROOM_STATES[roomCode];
  if (!state || !state.quiz) return;

  const players = state.players;

  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i];
    state.quiz.questionIndex = i;

    // 1) PHASE LOADING (prépare la question)
    io.to(roomCode).emit("phase", {
      type: "LOADING",
      questionIndex: i,
      duration: 800,
      startTime: Date.now(),
    });

    await wait(800);

    // 2) ENVOI DE LA QUESTION
    io.to(roomCode).emit("questionData", {
      questionText: q.questionText,
      imageUrl: q.imageUrl,
      answers: q.answers,
    });

    await wait(50);

    // 3) THINK (10s)
    io.to(roomCode).emit("phase", {
      type: "THINK",
      questionIndex: i,
      duration: 10000,
      startTime: Date.now(),
    });

    await wait(10000);

    // 4) ANSWER (20s) → joueur désigné
    const responder = players[i % players.length];

    io.to(roomCode).emit("phase", {
      type: "ANSWER",
      questionIndex: i,
      activePlayerId: responder.id,
      activePlayerName: responder.firstName,
      duration: 20000,
      startTime: Date.now(),
    });

    await wait(20000);

    // 5) RESULT (5s)
    io.to(roomCode).emit("phase", {
      type: "RESULT",
      questionIndex: i,
      correctIndex: q.correctIndex,
      duration: 5000,
      startTime: Date.now(),
    });

    await wait(5000);
  }

  // FIN DU QUIZ
  const finalScore = state.quiz.score;

  io.to(roomCode).emit("quizEnd", {
    score: finalScore,
    success: finalScore >= 4,
  });
}

// ======================================
// GAME 2 : QR CODES
// ======================================
function startGame2(roomCode) {
  // Récupérer les joueurs
  const room = db.prepare("SELECT * FROM rooms WHERE code = ?").get(roomCode);
  const players = db
    .prepare(
      `
      SELECT players.id, firstName, lastName
      FROM room_players
      JOIN players ON players.id = room_players.playerId
      WHERE room_players.roomId = ?
    `
    )
    .all(room.id);

  if (!players || players.length === 0) return;

  // On met le chef (owner) en premier
  const ownerId = room.ownerId;
  players.sort((a, b) => {
    if (a.id === ownerId) return -1;
    if (b.id === ownerId) return 1;
    return 0;
  });

  const totalQR = GAME2_QR.length; // 4
  const count = players.length;

  let distribution = [];

  if (count === 1) distribution = [4];
  if (count === 2) distribution = [2, 2];
  if (count === 3) distribution = [2, 1, 1]; // chef 2
  if (count >= 4) distribution = [1, 1, 1, 1];

  // Construire l'ordre des joueurs qui doivent scanner
  const order = [];
  for (let i = 0; i < players.length; i++) {
    const nb = distribution[i] || 0;
    for (let j = 0; j < nb; j++) {
      order.push(players[i]);
    }
  }

  // On garde l'état en mémoire
  ROOM_STATES[roomCode] = ROOM_STATES[roomCode] || {};
  ROOM_STATES[roomCode].players = players;
  ROOM_STATES[roomCode].game2 = {
    order,           // tableau de joueurs dans l'ordre de passage
    currentIndex: 0, // quel QR on est en train de chercher
    found: [],       // liste des ids QR trouvés
  };

  const next = order[0];
  const hint = GAME2_QR[0].hint;

  io.to(roomCode).emit("game2Start", {
    nextPlayerId: next.id,
    nextPlayerName: next.firstName,
    hint,
    progress: 0,
    total: totalQR,
    found: [],
  });
}

// Validation d'un QR code
app.post("/api/game2/validate", (req, res) => {
  const { roomCode, playerId, qr } = req.body;

  const roomState = ROOM_STATES[roomCode];
  if (!roomState || !roomState.game2) {
    return res.json({ success: false, message: "Épreuve 2 non démarrée." });
  }

  const game2 = roomState.game2;
  const index = game2.currentIndex;

  if (index >= GAME2_QR.length) {
    return res.json({ success: false, message: "Épreuve déjà terminée." });
  }

  const expectedQR = GAME2_QR[index];
  const expectedPlayer = game2.order[index];

  // Mauvais QR
  if (qr !== expectedQR.id) {
    return res.json({ success: false, message: "Ce n'est pas le bon QR code." });
  }

  // Mauvais joueur
  if (playerId !== expectedPlayer.id) {
    return res.json({
      success: false,
      message: "Ce n'est pas ton tour de scanner.",
    });
  }

  // OK → Valider
  if (!game2.found.includes(qr)) {
    game2.found.push(qr);
  }
  game2.currentIndex++;

  // Check fin
  const total = GAME2_QR.length;
  if (game2.currentIndex >= total) {
    io.to(roomCode).emit("game2Complete", {
      found: game2.found,
      total,
    });
    return res.json({ success: true });
  }

  // Joueur suivant
  const next = game2.order[game2.currentIndex];
  const nextHint = GAME2_QR[game2.currentIndex].hint;

  io.to(roomCode).emit("game2Progress", {
    found: game2.found,
    progress: game2.currentIndex,
    total,
    nextPlayerId: next.id,
    nextPlayerName: next.firstName,
    hint: nextHint,
  });

  res.json({ success: true });
});

// ======================================
// UTIL
// ======================================
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ======================================
const PORT = 4000;
http.listen(PORT, () =>
  console.log(`Backend lancé sur http://localhost:${PORT}`)
);
