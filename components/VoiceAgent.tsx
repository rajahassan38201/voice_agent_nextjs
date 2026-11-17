"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "agent"; text: string; ts: string };
type Status = "idle" | "connecting" | "live" | "speaking" | "error";

const VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"];
const STT = ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"];

export default function VoiceAgent() {
    // UI state
    const [status, setStatus] = useState<Status>("idle");
    const [messages, setMessages] = useState<Msg[]>([]);
    const [partial, setPartial] = useState("");
    const [turns, setTurns] = useState(0);
    const [interrupts, setInterrupts] = useState(0);
    const [micLevel, setMicLevel] = useState(0);
    const [agentLevel, setAgentLevel] = useState(0);
    const [elapsed, setElapsed] = useState("00:00");
    const [voice, setVoice] = useState("alloy");
    const [stt, setStt] = useState("gpt-4o-mini-transcribe");
    const [logs, setLogs] = useState<string[]>([]);
    const [toast, setToast] = useState<string | null>(null);

    // WebRTC refs (must NOT be state)
    const pcRef = useRef<RTCPeerConnection | null>(null);
    const dcRef = useRef<RTCDataChannel | null>(null);
    const micRef = useRef<MediaStream | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const ctxRef = useRef<AudioContext | null>(null);
    const micAnRef = useRef<AnalyserNode | null>(null);
    const agentAnRef = useRef<AnalyserNode | null>(null);
    const rafRef = useRef<number | null>(null);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const startedAtRef = useRef<number>(0);
    const busyRef = useRef(false);
    const maxMsRef = useRef(5 * 60 * 1000);
    const partialRef = useRef("");

    const log = useCallback((m: string) => {
        setLogs((l) => [...l.slice(-99), `[${new Date().toLocaleTimeString()}] ${m}`]);
    }, []);

    const showToast = useCallback((m: string) => {
        setToast(m);
        setTimeout(() => setToast(null), 4500);
    }, []);

    const stopAll = useCallback(() => {
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
        try { dcRef.current?.close(); } catch { }
        try { pcRef.current?.close(); } catch { }
        micRef.current?.getTracks().forEach((t) => t.stop());
        if (audioRef.current) audioRef.current.srcObject = null;
        try { ctxRef.current?.close(); } catch { }
        pcRef.current = dcRef.current = micRef.current = ctxRef.current = null;
        micAnRef.current = agentAnRef.current = null;
        partialRef.current = "";
        setPartial("");
        setStatus("idle");
        busyRef.current = false;
        log("Call ended.");
    }, [log]);

    const passcode = useCallback(() => {
        let c = typeof sessionStorage !== "undefined" ? sessionStorage.getItem("passcode") : null;
        if (!c) {
            c = window.prompt("Access code (leave blank if none set)") ?? "";
            if (typeof sessionStorage !== "undefined") sessionStorage.setItem("passcode", c);
        }
        return c;
    }, []);

    const waitIce = (pc: RTCPeerConnection) =>
        new Promise<void>((resolve) => {
            if (pc.iceGatheringState === "complete") return resolve();
            const to = setTimeout(() => resolve(), 1500);
            const onState = () => {
                if (pc.iceGatheringState === "complete") {
                    clearTimeout(to);
                    pc.removeEventListener("icegatheringstatechange", onState);
                    resolve();
                }
            };
            pc.addEventListener("icegatheringstatechange", onState);
        });

    const start = useCallback(async () => {
        if (busyRef.current) return;
        busyRef.current = true;
        setStatus("connecting");
        log("Starting…");
        try {
            const cfg = await fetch("/api/session").then((r) => r.json()).catch(() => ({}));
            maxMsRef.current = (cfg.maxMinutes || 5) * 60 * 1000;

            const pc = new RTCPeerConnection(); pcRef.current = pc;
            pc.ontrack = (e) => {
                if (!audioRef.current) return;
                audioRef.current.srcObject = e.streams[0];
                audioRef.current.play().catch(() => { });
            };
            pc.onconnectionstatechange = () => {
                const s = pc.connectionState;
                log(`peer: ${s}`);
                if (["failed", "disconnected", "closed"].includes(s) && status === "live") stopAll();
            };

            const mic = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
            micRef.current = mic;
            pc.addTrack(mic.getAudioTracks()[0], mic);

            const dc = pc.createDataChannel("oai-events"); dcRef.current = dc;
            dc.onopen = () => {
                dc.send(JSON.stringify({ type: "response.create" }));
                log("Data channel open — greeting requested");
            };
            dc.onmessage = (e) => {
                try { handleEvent(JSON.parse(e.data)); } catch { }
            };

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await waitIce(pc);

            const r = await fetch("/api/session", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-app-passcode": passcode(),
                },
                body: JSON.stringify({ sdp: pc.localDescription!.sdp, voice, stt }),
            });
            const answer = await r.text();
            if (!r.ok || !answer.includes("v=0")) throw new Error(`Session ${r.status}: ${answer.slice(0, 200)}`);
            await pc.setRemoteDescription({ type: "answer", sdp: answer });

            // Audio meters
            const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
            ctxRef.current = ctx;
            await ctx.resume();
            const micAn = ctx.createAnalyser(); micAn.fftSize = 512;
            ctx.createMediaStreamSource(mic).connect(micAn);
            micAnRef.current = micAn;
            if (audioRef.current?.srcObject) {
                try {
                    const agentAn = ctx.createAnalyser(); agentAn.fftSize = 512;
                    ctx.createMediaStreamSource(audioRef.current.srcObject as MediaStream).connect(agentAn);
                    agentAnRef.current = agentAn;
                } catch { }
            }

            startedAtRef.current = Date.now();
            setStatus("live");
            timerRef.current = setInterval(() => {
                const s = Math.floor((Date.now() - startedAtRef.current) / 1000);
                setElapsed(`${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`);
                if (Date.now() - startedAtRef.current > maxMsRef.current) {
                    log("Max session length reached.");
                    stopAll();
                    showToast("Session auto-ended (time limit).");
                }
            }, 500);

            const micBuf = new Uint8Array(micAn.fftSize);
            const agentBuf = agentAnRef.current ? new Uint8Array(agentAnRef.current.fftSize) : null;
            const tick = () => {
                let m = 0, a = 0;
                if (micAnRef.current) {
                    micAnRef.current.getByteTimeDomainData(micBuf);
                    let s = 0; for (let i = 0; i < micBuf.length; i++) { const v = (micBuf[i] - 128) / 128; s += v * v; }
                    m = Math.sqrt(s / micBuf.length);
                }
                if (agentAnRef.current && agentBuf) {
                    agentAnRef.current.getByteTimeDomainData(agentBuf);
                    let s = 0; for (let i = 0; i < agentBuf.length; i++) { const v = (agentBuf[i] - 128) / 128; s += v * v; }
                    a = Math.sqrt(s / agentBuf.length);
                }
                setMicLevel(Math.min(1, m * 4));
                setAgentLevel(Math.min(1, a * 4));
                rafRef.current = requestAnimationFrame(tick);
            };
            rafRef.current = requestAnimationFrame(tick);
            log("Live. Speak any time.");
        } catch (err) {
            log(`ERROR: ${(err as Error).message}`);
            showToast((err as Error).message.split("\n")[0]);
            setStatus("error");
            stopAll();
        }
    }, [voice, stt, log, showToast, passcode, stopAll, status]);

    const handleEvent = (ev: any) => {
        const t = ev.type || "";
        switch (t) {
            case "response.output_audio_transcript.delta":
            case "response.audio_transcript.delta":
                partialRef.current += ev.delta || "";
                setPartial(partialRef.current);
                break;
            case "response.output_audio_transcript.done":
            case "response.audio_transcript.done":
                if (ev.transcript) partialRef.current = ev.transcript;
                flushPartial();
                break;
            case "conversation.item.input_audio_transcription.completed":
                flushPartial();
                if (ev.transcript?.trim()) {
                    setMessages((m) => [...m, { role: "user", text: ev.transcript.trim(), ts: new Date().toLocaleTimeString() }]);
                    setTurns((n) => n + 1);
                }
                break;
            case "input_audio_buffer.speech_started":
                setInterrupts((n) => n + 1);
                flushPartial(" ⏹ (interrupted)");
                if (audioRef.current) audioRef.current.muted = true;
                setTimeout(() => { if (audioRef.current) audioRef.current.muted = false; }, 150);
                break;
            case "response.done":
                flushPartial();
                break;
            case "session.created":
            case "session.updated":
                log(`✓ ${t}`);
                break;
            case "error":
                log(`API error: ${JSON.stringify(ev.error)}`);
                showToast(ev.error?.message || "API error");
                break;
        }
    };

    const flushPartial = (suffix = "") => {
        const txt = partialRef.current.trim();
        if (txt) {
            setMessages((m) => [...m, { role: "agent", text: txt + suffix, ts: new Date().toLocaleTimeString() }]);
        }
        partialRef.current = "";
        setPartial("");
    };

    // Auto-scroll chat
    const chatRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }, [messages, partial]);

    // Cleanup on unmount
    useEffect(() => () => stopAll(), [stopAll]);

    const orbScale = 1 + Math.max(micLevel, agentLevel) * 0.6;
    const orbColor = status === "live" || status === "speaking" ? "bg-indigo-600"
        : status === "connecting" ? "bg-amber-400"
            : status === "error" ? "bg-rose-500"
                : "bg-slate-300";

    const pillColor = status === "live" || status === "speaking" ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
        : status === "connecting" ? "bg-amber-50 text-amber-700 ring-amber-200"
            : status === "error" ? "bg-rose-50 text-rose-700 ring-rose-200"
                : "bg-slate-100 text-slate-600 ring-slate-200";

    return (
        <div className="grid gap-5 lg:grid-cols-5">
            {/* Control panel */}
            <section className="lg:col-span-2">
                <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
                    <div className="relative grid h-52 place-items-center">
                        <div className="absolute h-44 w-44 rounded-full bg-indigo-500/10 transition-transform duration-100"
                            style={{ transform: `scale(${orbScale})`, opacity: status === "idle" ? 0 : 1 }} />
                        <div className="absolute h-32 w-32 rounded-full bg-indigo-500/20 transition-transform duration-100"
                            style={{ transform: `scale(${1 + orbScale * 0.3})`, opacity: status === "idle" ? 0 : 1 }} />
                        <div className={`relative grid h-24 w-24 place-items-center rounded-full shadow-lg transition-colors duration-300 ${orbColor}`}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" className="h-9 w-9">
                                <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                                <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" />
                            </svg>
                        </div>
                    </div>

                    <p className="text-center text-sm font-medium text-slate-600">
                        {status === "idle" && "Ready when you are"}
                        {status === "connecting" && "Connecting…"}
                        {status === "live" && "Listening — just talk"}
                        {status === "speaking" && "Agent is speaking…"}
                        {status === "error" && "Something went wrong"}
                    </p>

                    <div className="mt-5 flex gap-2.5">
                        <button onClick={start} disabled={status !== "idle" && status !== "error"}
                            className="flex-1 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300">
                            Start call
                        </button>
                        <button onClick={stopAll} disabled={status === "idle" || status === "connecting"}
                            className="flex-1 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400">
                            End
                        </button>
                    </div>

                    <div className="mt-5">
                        <div className="mb-1.5 flex justify-between text-[11px] font-medium uppercase tracking-wide text-slate-600">
                            <span>Microphone</span><span>{Math.round(micLevel * 100)}%</span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                            <div className="h-full rounded-full bg-indigo-600 transition-[width] duration-75"
                                style={{ width: `${micLevel * 100}%` }} />
                        </div>
                    </div>

                    <div className="mt-5 grid grid-cols-3 gap-2.5">
                        <Stat label="Duration" value={elapsed} />
                        <Stat label="Your turns" value={String(turns)} />
                        <Stat label="Interrupts" value={String(interrupts)} />
                    </div>

                    <details className="mt-5 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
                        <summary className="cursor-pointer text-sm font-semibold text-slate-700">Settings</summary>
                        <div className="mt-4 space-y-3">
                            <div>
                                <label className="mb-1 block text-xs font-medium text-slate-600">Voice</label>
                                <select value={voice} onChange={(e) => setVoice(e.target.value)}
                                    className="w-full rounded-lg border-0 bg-white px-3 py-2 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-indigo-500">
                                    {VOICES.map((v) => <option key={v}>{v}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="mb-1 block text-xs font-medium text-slate-600">Transcription model</label>
                                <select value={stt} onChange={(e) => setStt(e.target.value)}
                                    className="w-full rounded-lg border-0 bg-white px-3 py-2 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-indigo-500">
                                    {STT.map((v) => <option key={v}>{v}</option>)}
                                </select>
                            </div>
                            <p className="text-xs text-slate-600">Instructions are locked on the server for security. Changes apply on the next call.</p>
                        </div>
                    </details>

                    <p className="mt-4 rounded-xl bg-amber-50 px-3.5 py-2.5 text-xs leading-relaxed text-amber-800 ring-1 ring-amber-200">
                        Browser echo cancellation is on, so speakers usually work. Headphones still give the cleanest result.
                    </p>
                </div>
            </section>

            {/* Transcript */}
            <section className="lg:col-span-3">
                <div className="flex flex-col rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
                    <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
                        <div className="flex items-center gap-3">
                            <h2 className="text-sm font-semibold">Conversation</h2>
                            <span className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${pillColor}`}>● {status.toUpperCase()}</span>
                        </div>
                        <div className="flex gap-2">
                            <button onClick={() => { setMessages([]); setTurns(0); setInterrupts(0); setPartial(""); }}
                                className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100">Clear</button>
                            <button onClick={() => {
                                const txt = messages.map((m) => `[${m.ts}] ${m.role === "user" ? "You" : "Agent"}: ${m.text}`).join("\n") || "empty";
                                const a = document.createElement("a");
                                a.href = URL.createObjectURL(new Blob([txt], { type: "text/plain" }));
                                a.download = `voice_session_${Date.now()}.txt`; a.click(); URL.revokeObjectURL(a.href);
                            }} className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100">Download</button>
                        </div>
                    </div>

                    <div ref={chatRef} className="scroll flex-1 space-y-3 overflow-y-auto px-5 py-4" style={{ minHeight: 420, maxHeight: "60vh" }}>
                        {messages.length === 0 && !partial && (
                            <div className="grid place-items-center py-20 text-center">
                                <div>
                                    <p className="text-sm font-medium text-slate-600">No conversation yet</p>
                                    <p className="mt-1 text-xs text-slate-500">
                                        Press <span className="font-semibold text-indigo-600">Start call</span> and just talk.
                                    </p>
                                </div>
                            </div>
                        )}
                        {messages.map((m, i) => <Bubble key={i} role={m.role} text={m.text} ts={m.ts} />)}
                        {partial && <Bubble role="agent" text={partial} ts="" caret />}
                    </div>

                    <div className="border-t border-slate-200 px-5 py-3">
                        <details>
                            <summary className="cursor-pointer text-xs font-medium text-slate-600">Logs ({logs.length})</summary>
                            <pre className="scroll mt-2 max-h-40 overflow-auto rounded-lg bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-700 ring-1 ring-slate-200">
                                {logs.join("\n")}
                            </pre>
                        </details>
                    </div>
                </div>
            </section>

            <audio ref={audioRef} autoPlay playsInline />

            {toast && (
                <div className="pointer-events-none fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg">
                    {toast}
                </div>
            )}
        </div>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-xl bg-slate-50 p-3 text-center ring-1 ring-slate-200">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-600">{label}</div>
            <div className="mt-0.5 text-lg font-bold">{value}</div>
        </div>
    );
}

function Bubble({ role, text, ts, caret }: { role: "user" | "agent"; text: string; ts?: string; caret?: boolean }) {
    const mine = role === "user";
    return (
        <div className={`fade-in flex ${mine ? "justify-end" : "justify-start"}`}>
            <div className={mine
                ? "max-w-[82%] rounded-2xl rounded-br-sm bg-indigo-600 px-4 py-2.5 text-white shadow-sm"
                : "max-w-[82%] rounded-2xl rounded-bl-sm bg-slate-100 px-4 py-2.5 text-slate-900 ring-1 ring-slate-200"}>
                {ts && <div className={`mb-0.5 text-[11px] ${mine ? "text-indigo-200" : "text-slate-600"}`}>
                    {mine ? "You" : "Agent"} · {ts}
                </div>}
                <div className={`whitespace-pre-wrap text-sm leading-relaxed ${caret ? "caret" : ""}`}>{text}</div>
            </div>
        </div>
    );
}