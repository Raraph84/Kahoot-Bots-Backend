const { spawn } = require("child_process");
const { getConfig, WebSocketServer } = require("raraph84-lib");
const EventEmitter = require("events");
const OpenAI = require("openai");
const config = getConfig(__dirname);

const prompt = {
    role: "system",
    content: [
        "Tu est un robot qui va répondre à un QCM.",
        "Je vais te donner la question et les réponses numérotées.",
        "Il n'y a toujours une seule réponse, quand tu ne sais pas, prend la réponse la plus probable ou choisis aléatoirement.",
        "Tu devras réponse sous le format JSON toujours sous la forme {\"reply\":answer}.",
        "Exemple :",
        "Moi :",
        "Question : Quel est la capitale de la France ?",
        "Réponse 1 : Paris",
        "Réponse 2 : Londres",
        "Toi :",
        "{\"reply\":1}"
    ].join("\n")
};

const openai = new OpenAI({ apiKey: config.openaiApiKey });

let code = null;
let question = null;
const bots = [];

let lastState = null;
const sendState = () => {
    const newState = JSON.parse(JSON.stringify({
        code,
        question,
        bots: bots.map((bot) => ({
            wantedName: bot.wantedName,
            name: bot.name,
            ready: bot.ready,
            joined: bot.joined,
            a2f: bot.a2f,
            a2fFail: bot.a2fFail,
            exited: bot.exited
        }))
    }));
    if (JSON.stringify(newState) === JSON.stringify(lastState)) return;
    lastState = newState;
    server.clients.filter((client) => client.infos.logged).forEach((client) => client.emitEvent("STATE", newState));
}

class Bot extends EventEmitter {

    #proc;
    ready = false;
    joined = false;
    name = null;
    a2f = false;
    a2fFail = false;
    exited = false;

    constructor() {

        super();

        this.#proc = spawn("node", ["bot.js"]);

        let data = "";
        this.#proc.stdout.on("data", (chunk) => {
            data += chunk;
            while (data.includes("\n")) {
                const line = data.split("\n")[0];
                data = data.replace(line + "\n", "");
                let message;
                try {
                    message = JSON.parse(line);
                } catch (error) {
                    continue;
                }
                this.emit("rawMessage", message);
            }
        });
        // this.#proc.stdout.pipe(process.stdout);
        this.#proc.stderr.pipe(process.stderr);

        this.on("rawMessage", (message) => {

            if (message.event === "ready") {
                this.ready = true;
                this.emit("ready");
            } else if (message.event === "a2f") {
                this.a2f = true;
                this.emit("a2f");
            } else if (message.event === "a2ffail") {
                this.a2fFail = true;
                this.emit("a2ffail");
            } else if (message.event === "a2freset") {
                this.a2fFail = false;
                this.emit("a2freset");
            } else if (message.event === "joined") {
                this.joined = true;
                this.name = message.name;
                this.a2f = false;
                this.emit("joined", message.name);
            } else if (message.event === "question")
                this.emit("question", message.type, message.answersCount, message.allowedAnswers, message.question, message.answers);
            else if (message.event === "playing")
                this.emit("playing", message.timeLeft);
            else if (message.event === "end")
                this.emit("end", message.correct);
        });

        this.#proc.on("exit", () => {
            this.exited = true;
            this.emit("exit");
        });
    }

    join(code, name) {
        this.#send({ command: "join", code, name });
    }

    sendA2f(a2f) {
        this.#send({ command: "a2f", a2f });
    }

    answer(answer) {
        this.#send({ command: "answer", answer });
    }

    remove() {
        this.#proc.kill();
    }

    #send(message) {
        this.#proc.stdin.write(JSON.stringify(message) + "\n");
    }
}

const initPlayBot = (bot) => {

    bot.on("question", async (type, answersCount, allowedAnswers, q, answers) => {

        question = {
            type,
            answersCount,
            allowedAnswers,
            question: q,
            answers,
            askingChatGpt: !!q,
            answer: null,
            correct: null
        };

        sendState();

        if (!!q) {

            console.log("Question : " + q);

            const completion = await openai.chat.completions.create({
                messages: [
                    prompt,
                    {
                        role: "system",
                        content: [
                            "Question : " + q,
                            ...answers.map((answer, index) => "Réponse " + (index + 1) + " : " + answer)
                        ].join("\n")
                    }
                ], model: "gpt-4-turbo"
            });

            let answer;
            try {
                answer = parseInt(JSON.parse(completion.choices[0].message.content).reply) - 1;
            } catch (error) {
            }

            if (typeof answer !== "number" || !answers[answer]) answer = Math.floor(Math.random() * answers.length);

            console.log("Réponse : " + answers[answer]);

            if (question.answer !== null || question.correct !== null) return;

            question.answer = answer;
            question.askingChatGpt = false;
            sendState();

            bots.filter((bot) => bot.joined).forEach((bot) => bot.answer(answer));
        }
    });
    bot.on("end", (correct) => {
        if (!question) return;
        question.correct = correct;
        question.askingChatGpt = false;
        sendState();
    });
}

const addBot = (name) => {
    const bot = new Bot();
    bot.wantedName = name;
    bot.on("ready", () => {
        sendState();
        const interval = setInterval(() => {
            if (code) {
                bot.join(code, bot.wantedName);
                clearInterval(interval);
            }
        }, 100);
    });
    bot.on("a2f", () => sendState());
    bot.on("a2ffail", () => sendState());
    bot.on("a2freset", () => { sendState(); server.clients.filter((client) => client.infos.logged).forEach((client) => client.emitEvent("A2F_RESET")); });
    bot.on("joined", () => sendState());
    bot.on("exit", () => sendState());
    return bot;
}

const server = new WebSocketServer();
server.on("connection", (/** @type {import("raraph84-lib/src/WebSocketClient")} */ client) => {
    setTimeout(() => {
        if (!client.infos.logged)
            client.close("Please login");
    }, 10 * 1000);
});
server.on("command", (command, /** @type {import("raraph84-lib/src/WebSocketClient")} */ client, message) => {

    if (command === "LOGIN") {

        if (typeof message.token === "undefined") {
            client.close("Missing token");
            return;
        }

        if (typeof message.token !== "string") {
            client.close("Token must be a string");
            return;
        }

        if (message.token !== config.token) {
            client.close("Invalid token");
            return;
        }

        client.infos.logged = true;
        client.emitEvent("LOGGED");
        client.emitEvent("STATE", lastState);

    } else if (command === "SET_CODE") {

        if (!client.infos.logged) {
            client.close("Please login");
            return;
        }

        if (typeof message.code === "undefined") {
            client.close("Missing code");
            return;
        }

        if (typeof message.code !== "string") {
            client.close("Code must be a string");
            return;
        }

        if (!/^[\d]{0,8}$/.test(message.code)) {
            client.close("Invalid code");
            return;
        }

        if (code) {
            for (let i = 0; i < bots.length; i++) {
                bots[i].remove();
                const bot = addBot(bots[i].wantedName);
                if (i === 0) initPlayBot(bot);
                bots[i] = bot;
            }
        }

        code = message.code;
        sendState();

    } else if (command === "ADD_BOT") {

        if (!client.infos.logged) {
            client.close("Please login");
            return;
        }

        if (typeof message.name === "undefined") {
            client.close("Missing name");
            return;
        }

        if (typeof message.name !== "string") {
            client.close("Name must be a string");
            return;
        }

        const bot = addBot(message.name);
        if (bots.length === 0) initPlayBot(bot);
        bots.push(bot);
        sendState();

    } else if (command === "A2F") {

        if (!client.infos.logged) {
            client.close("Please login");
            return;
        }

        if (typeof message.a2f === "undefined") {
            client.close("Missing a2f");
            return;
        }

        if (!Array.isArray(message.a2f)) {
            client.close("A2f must be an array");
            return;
        }

        if (message.a2f.length !== 4) {
            client.close("A2f must have 4 elements");
            return;
        }

        if (message.a2f.some((a2f) => typeof a2f !== "string")) {
            client.close("A2f elements must be strings");
            return;
        }

        if (message.a2f.some((a2f) => !["triangle", "diamond", "circle", "square"].includes(a2f))) {
            client.close("A2f elements must be triangle, diamond, circle or square");
            return;
        }

        if (new Set(message.a2f).size !== message.a2f.length) {
            client.close("A2f elements must be unique");
            return;
        }

        if (!bots.some((bot) => bot.a2f)) {
            client.close("No bot waiting for a2f");
            return;
        }

        if (bots.some((bot) => bot.a2fFailed)) {
            client.close("A2f failed");
            return;
        }

        bots.filter((bot) => bot.a2f).forEach((bot) => bot.sendA2f(message.a2f));

    } else if (command === "ANSWER") {

        if (!client.infos.logged) {
            client.close("Please login");
            return;
        }

        if (typeof message.answer === "undefined") {
            client.close("Missing answer");
            return;
        }

        if (typeof message.answer !== "number") {
            client.close("Answer must be a number");
            return;
        }

        if (!question) {
            client.close("No question");
            return;
        }

        if (message.answer < 0 || message.answer >= question.answersCount) {
            client.close("Invalid answer");
            return;
        }

        if (question.answer !== null) {
            client.close("Question already answered");
            return;
        }

        question.answer = message.answer;
        question.askingChatGpt = false;
        sendState();

        bots.filter((bot) => bot.joined).forEach((bot) => bot.answer(message.answer));

    } else if (command === "REMOVE_BOT") {

        if (!client.infos.logged) {
            client.close("Please login");
            return;
        }

        if (typeof message.id === "undefined") {
            client.close("Missing id");
            return;
        }

        if (typeof message.id !== "number") {
            client.close("Id must be a number");
            return;
        }

        const bot = bots[message.id];
        if (!bot) {
            client.close("Invalid id");
            return;
        }

        bot.remove();
        bots.splice(message.id, 1);
        if (message.id === 0 && bots.length > 0) initPlayBot(bots[0]);
        sendState();

    } else
        client.close("Unknown command");
});

sendState();

console.log("Lancement du serveur WebSocket sur le port " + config.port + "...");
server.listen(config.port).then(() => console.log("Serveur WebSocket lancé sur le port " + config.port + " !")).catch((error) => console.log("Impossible de lancer le serveur WebSocket ! " + error));
