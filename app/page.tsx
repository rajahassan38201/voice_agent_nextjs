import VoiceAgent from "@/components/VoiceAgent";

export default function Home() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-indigo-600 text-white shadow-sm">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
                <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" />
              </svg>
            </div>
            <div>
              <h1 className="text-[15px] font-semibold tracking-tight">Planning Additions — Voice Support</h1>
              <p className="text-xs text-slate-600">Architecture · Planning · Engineering</p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-6">
        <VoiceAgent />
      </main>

      <footer className="mx-auto max-w-6xl px-5 pb-8 text-center text-xs text-slate-500">
        Audio runs browser → OpenAI directly. Your API key stays on the server.
      </footer>
    </div>
  );
}