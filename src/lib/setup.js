// One-time setup script: creates staff login accounts.
// Usage: npm run setup
// Prompts interactively for each staff member's name, email, and password.
// Run it again any time to add another staff account.

const readline = require("readline");
const bcrypt = require("bcryptjs");
const db = require("./db");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
const askHidden = (q) =>
  new Promise((resolve) => {
    // Simple hidden-input prompt for the password.
    const stdin = process.stdin;
    process.stdout.write(q);
    stdin.resume();
    stdin.setRawMode(true);
    let input = "";
    const onData = (char) => {
      char = char.toString();
      if (char === "\n" || char === "\r" || char === "") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(input);
      } else if (char === "") {
        process.exit(1);
      } else if (char === "") {
        input = input.slice(0, -1);
      } else {
        input += char;
      }
    };
    stdin.on("data", onData);
  });

async function main() {
  console.log("=== Add a staff login for the funeral streaming admin portal ===\n");
  const name = await ask("Staff member's name: ");
  const email = (await ask("Login email: ")).trim().toLowerCase();
  const password = await askHidden("Password (min 8 characters): ");

  if (!name || !email || !password || password.length < 8) {
    console.error("\nAll fields are required and the password must be at least 8 characters. Nothing was saved.");
    rl.close();
    process.exit(1);
  }

  const existing = db.prepare("SELECT id FROM staff WHERE email = ?").get(email);
  if (existing) {
    console.error(`\nA staff account with email ${email} already exists. Nothing was saved.`);
    rl.close();
    process.exit(1);
  }

  const passwordHash = bcrypt.hashSync(password, 12);
  db.prepare("INSERT INTO staff (name, email, password_hash) VALUES (?, ?, ?)").run(name, email, passwordHash);

  console.log(`\nDone. ${name} <${email}> can now log in at /admin/login.`);
  rl.close();
}

main();
