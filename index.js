const express = require("express");
const cors = require("cors");
const { db, run, get, all } = require("./db"); // sqlite3 version
const app = express();

const http = require("http").createServer(app);
const { Server } = require("socket.io");

const io = new Server(http, {
  cors: { origin: "*" },
});

app.use(cors());
app.use(express.json());

// ======================================================
// ROUTE TEST
// ======================================================
app.get("/", (req, res) => {
  res.json({ message: "Backend OK" });
});

// ======================================================
// ROUTE : CRÉATION D’UN JOUEUR
// ======================================================
app.post("/api/player", async (req, res) => {
  const { firstName, lastName } = req.body;
  if (!firstName || !lastName)
    return res.status(400).json({ error: "Nom et prénom requis" });

  const now = new Date().toISOString();

  const result = await run(
    `INSERT INTO players (firstName, lastName, createdAt)
     VALUES (?, ?, ?)`,
    [firstName, lastName, now]
  );

  res.json({
    id: result.lastID,
    firstName,
    lastName,
    createdAt: now,
  });
});

// ======================================================
// UTILITAIRE : CODE DE SALON
// ======================================================
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

// ======================================================
// ROUTE : CRÉER UN SALON
// ======================================================
app.post("/api/room/create", async (req, res) => {
  const { playerId } = req.body;
  if (!playerId) return res.status(400).json({ error: "playerId requis" });

  let code = generateRoomCode();
  while (await get("SELECT * FROM rooms WHERE code = ?", [code])) {
    code = generateRoomCode();
  }

  const now = new Date().toISOString();

  const roomResult = await run(
    `INSERT INTO rooms (code, ownerId, createdAt)
     VALUES (?, ?, ?)`,
    [code, playerId, now]
  );

  await run(
    `INSERT INTO room_players (playerId, roomId, isOwner, joinedAt)
     VALUES (?, ?, 1, ?)`,
    [playerId, roomResult.lastID, now]
  );

  res.json({
    roomId: roomResult.lastID,
    code,
    ownerId: playerId,
  });
});

// ======================================================
// ROUTE : REJOINDRE UN SALON
// ======================================================
app.post("/api/room/join", async (req, res) => {
  const { playerId, code } = req.body;
  if (!playerId || !code)
    return res.status(400).json({ error: "playerId et code requis" });

  const room = await get("SELECT * FROM rooms WHERE code = ?", [code]);
  if (!room) return res.status(404).json({ error: "Salon introuvable" });

  const now = new Date().toISOString();

  const exists = await get(
    "SELECT * FROM room_players WHERE playerId = ? AND roomId = ?",
    [playerId, room.id]
  );

  if (!exists) {
    await run(
      `INSERT INTO room_players (playerId, roomId, isOwner, joinedAt)
       VALUES (?, ?, 0, ?)`,
      [playerId, room.id, now]
    );
  }

  res.json({
    roomId: room.id,
    code: room.code,
    ownerId: room.ownerId,
  });
});

// ======================================================
// ROUTE : LISTE DES JOUEURS DU SALON
// ======================================================
app.get("/api/room/players/:code", async (req, res) => {
  const room = await get("SELECT * FROM rooms WHERE code = ?", [
    req.params.code,
  ]);

  if (!room) return res.status(404).json({ error: "Room not found" });

  const players = await all(
    `SELECT players.id, firstName, lastName
     FROM room_players
     JOIN players ON players.id = room_players.playerId
     WHERE room_players.roomId = ?`,
    [room.id]
  );

  res.json({ players, ownerId: room.ownerId });
});

// ======================================================
// QUESTIONS
// ======================================================
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

// ======================================================
// SOCKET.IO
// ======================================================
const ROOM_STATES = {};

io.on("connection", (socket) => {
  console.log("Socket connecté :", socket.id);

  socket.on("joinRoom", (roomCode) => socket.join(roomCode));

  socket.on("startGame", (roomCode) => startQuiz(roomCode));

  socket.on("answer", ({ roomCode, chosenIndex }) => {
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

// ======================================================
// QUIZ
// ======================================================
async function startQuiz(roomCode) {
  const room = await get("SELECT * FROM rooms WHERE code = ?", [roomCode]);

  const players = await all(
    `SELECT players.id, firstName, lastName
     FROM room_players
     JOIN players ON players.id = room_players.playerId
     WHERE room_players.roomId = ?`,
    [room.id]
  );

  ROOM_STATES[roomCode] = {
    questionIndex: 0,
    score: 0,
    players,
  };

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

  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i];
    state.questionIndex = i;

    io.to(roomCode).emit("phase", {
      type: "LOADING",
      duration: 800,
      questionIndex: i,
      startTime: Date.now(),
    });

    await wait(800);

    io.to(roomCode).emit("questionData", {
      questionText: q.questionText,
      imageUrl: q.imageUrl,
      answers: q.answers,
    });

    await wait(50);

    io.to(roomCode).emit("phase", {
      type: "THINK",
      duration: 10000,
      questionIndex: i,
      startTime: Date.now(),
    });

    await wait(10000);

    const responder = state.players[i % state.players.length];

    io.to(roomCode).emit("phase", {
      type: "ANSWER",
      duration: 20000,
      activePlayerId: responder.id,
      activePlayerName: responder.firstName,
      questionIndex: i,
      startTime: Date.now(),
    });

    await wait(20000);

    io.to(roomCode).emit("phase", {
      type: "RESULT",
      duration: 5000,
      correctIndex: q.correctIndex,
      questionIndex: i,
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

// ======================================================
const PORT = process.env.PORT || 4000;
http.listen(PORT, () =>
  console.log(`Backend lancé sur port ${PORT}`)
);
