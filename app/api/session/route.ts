import { RULES } from "@/lib/kb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
    return Response.json(
        {
            model: process.env.REALTIME_MODEL ?? "gpt-realtime",
            maxMinutes: Number(process.env.MAX_SESSION_MINUTES ?? 5),
        },
        { headers: NO_STORE }
    );
}

export async function POST(req: Request) {
    const pass = process.env.APP_PASSCODE ?? "";
    if (pass && req.headers.get("x-app-passcode") !== pass)
        return Response.json({ error: "Invalid access code." }, { status: 401, headers: NO_STORE });

    let body: Record<string, string> = {};
    try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400, headers: NO_STORE }); }

    const { sdp, voice = "alloy", stt = "gpt-4o-mini-transcribe" } = body;
    if (typeof sdp !== "string" || !sdp.includes("v=0"))
        return Response.json({ error: "Valid SDP required." }, { status: 400, headers: NO_STORE });

    const key = process.env.OPENAI_API_KEY;
    if (!key) return Response.json({ error: "Server key missing." }, { status: 503, headers: NO_STORE });

    const fd = new FormData();
    fd.set("sdp", sdp);
    fd.set(
        "session",
        JSON.stringify({
            type: "realtime",
            model: process.env.REALTIME_MODEL ?? "gpt-realtime",
            instructions: RULES,
            audio: {
                output: { voice: String(voice).slice(0, 32) },
                input: {
                    transcription: { model: String(stt).slice(0, 64) },
                    turn_detection: { type: "server_vad" },
                },
            },
        })
    );

    try {
        const r = await fetch("https://api.openai.com/v1/realtime/calls", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${key}`,
                "OpenAI-Safety-Identifier": "pa-web-anon",
            },
            body: fd,
        });
        const text = await r.text();
        const headers: Record<string, string> = {
            "Content-Type": r.ok ? "application/sdp" : "text/plain",
            ...NO_STORE,
        };
        const loc = r.headers.get("Location");
        if (loc) headers["Location"] = loc;
        return new Response(text, { status: r.status, headers });
    } catch (e) {
        return Response.json({ error: String(e) }, { status: 502, headers: NO_STORE });
    }
}