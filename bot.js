const EventEmitter = require("events");
const Puppeteer = require("puppeteer");

const events = new EventEmitter();

let data = "";
process.stdin.on("data", (chunk) => {
    data += chunk;
    while (data.includes("\n")) {
        const line = data.split("\n")[0];
        data = data.replace(line + "\n", "");
        let message;
        try {
            message = JSON.parse(line);
        } catch (error) {
            return;
        }
        events.emit("message", message);
    }
});

events.send = (message) => process.stdout.write(JSON.stringify(message) + "\n");

(async () => {

    const browser = await Puppeteer.launch({
        headless: "new",
        defaultViewport: null,
        args: ["--start-maximized", "--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = (await browser.pages())[0];

    const websocketEvents = new EventEmitter();
    const client = await page.target().createCDPSession();
    await client.send("Network.enable");
    client.on("Network.webSocketCreated", ({ requestId, url }) => websocketEvents.emit("connected"));
    client.on("Network.webSocketClosed", ({ requestId, timestamp }) => websocketEvents.emit("disconnected"));
    client.on("Network.webSocketFrameSent", ({ requestId, timestamp, response }) => {

        let messages;
        try {
            messages = JSON.parse(response.payloadData);
        } catch (error) {
            return;
        }

        // for (const message of messages) console.log("->", message);

        for (const message of messages)
            websocketEvents.emit("sent", message);
    });
    client.on("Network.webSocketFrameReceived", ({ requestId, timestamp, response }) => {

        let messages;
        try {
            messages = JSON.parse(response.payloadData);
        } catch (error) {
            return;
        }

        // for (const message of messages) console.log("<-", message);

        for (const message of messages)
            websocketEvents.emit("received", message);
    });

    await page.goto("https://kahoot.it/");

    events.send({ event: "ready" });

    let name = null;
    let code = null;
    await new Promise((resolve) => events.on("message", (message) => {
        if (message.command !== "join") return;
        name = message.name;
        code = message.code;
        resolve();
    }));

    websocketEvents.on("sent", async (message) => { if (message.channel === "/service/controller" && message.data && message.data.name) name = message.data.name; });

    await page.waitForSelector("#game-input");
    await page.type("#game-input", code);
    await page.click(".button__Button-sc-vzgdbz-0");
    const canChoose = await Promise.race([
        new Promise((resolve) => page.waitForSelector("#nickname").then(() => resolve(true)).catch(() => { })),
        new Promise((resolve) => page.waitForSelector("button[data-functional-selector='namerator-spin-button']").then(() => resolve(false)).catch(() => { }))
    ]);
    if (canChoose) {
        websocketEvents.on("received", async (message) => {
            if (message.channel === "/service/controller" && message.data && message.data.description === "Duplicate name")
                process.exit();
        });
        await page.waitForSelector("#nickname");
        await page.type("#nickname", name);
        await page.click(".button__Button-sc-vzgdbz-0");
    } else {
        websocketEvents.on("received", async (message) => {
            if (message.channel === "/service/controller" && message.data && message.data.description === "Duplicate name") {
                try {
                    await page.click("button[data-functional-selector='namerator-spin-button']");
                } catch (error) {
                    process.exit();
                }
                await page.waitForSelector("button[data-functional-selector='namerator-continue-button']");
                await page.click("button[data-functional-selector='namerator-continue-button']");
            }
        });
        await page.click("button[data-functional-selector='namerator-spin-button']");
        await page.waitForSelector("button[data-functional-selector='namerator-continue-button']");
        await page.click("button[data-functional-selector='namerator-continue-button']");
    }

    await new Promise((resolve) => websocketEvents.on("received", (message) => {

        if (message.channel !== "/service/player") return;

        const content = JSON.parse(message.data.content);

        if (message.data.id === 17) {

            if (content.loginState === 3) {

                websocketEvents.removeAllListeners("received");
                resolve();

            } else if (content.loginState === 0) {

                events.send({ event: "a2f" });

                events.on("message", async (message) => {
                    if (message.command !== "a2f") return;
                    for (const a2f of message.a2f)
                        await page.click("button[data-functional-selector='two-factor-cards__" + a2f + "-button']");
                });
            }

        } else if (message.data.id === 51) {

            events.send({ event: "a2ffail" });

        } else if (message.data.id === 53) {

            events.send({ event: "a2freset" });
        }
    }));

    events.removeAllListeners("message");
    events.send({ event: "joined", name });

    let state = "waiting";
    let answer = null;

    websocketEvents.on("received", (message) => {

        if (message.channel !== "/service/player") return;

        const content = JSON.parse(message.data.content);

        if (message.data.id === 1) {

            state = "asking";
            if (content.layout && !["CLASSIC", "TRUE_FALSE"].includes(content.layout)) return;

            const question = content.title;
            const answers = content.choices?.map((choice) => choice.answer);

            events.send({ event: "question", type: content.layout === "TRUE_FALSE" ? "truefalse" : "classic", answersCount: content.numberOfChoices, allowedAnswers: content.numberOfAnswersAllowed, question, answers });

            events.on("message", (message) => {

                if (message.command !== "answer") return;

                if (state !== "playing") {
                    answer = message.answer;
                    return;
                }

                page.click("div[data-functional-selector='question-choice-text-" + message.answer + "']");
            });

        } else if (message.data.id === 2) {

            state = "playing";

            events.send({ event: "playing", timeLeft: content.timeLeft });

            if (answer !== null)
                page.click("div[data-functional-selector='question-choice-text-" + answer + "']");

        } else if (message.data.id === 8) {

            answer = null;
            state = "waiting";

            events.send({ event: "end", correct: content.isCorrect });
            events.removeAllListeners("message");
        }
    });

})();
