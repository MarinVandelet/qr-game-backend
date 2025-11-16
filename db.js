const Database = require('better-sqlite3');

// Création auto du fichier
const db = new Database('database.db');

// Création des tables
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    firstName TEXT NOT NULL,
    lastName TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    ownerId INTEGER NOT NULL,
    createdAt TEXT NOT NULL,
    FOREIGN KEY(ownerId) REFERENCES players(id)
  );

  CREATE TABLE IF NOT EXISTS room_players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playerId INTEGER NOT NULL,
    roomId INTEGER NOT NULL,
    isOwner INTEGER NOT NULL DEFAULT 0,
    joinedAt TEXT NOT NULL,
    FOREIGN KEY(playerId) REFERENCES players(id),
    FOREIGN KEY(roomId) REFERENCES rooms(id)
  );
`);

module.exports = db;
