export function speakWithVoice(
  voice: SpeechSynthesisVoice,
  text: string,
  rate: number,
  events: { end(): void; error(): void },
) {
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = voice.lang
  utterance.voice = voice
  utterance.rate = rate
  utterance.onend = events.end
  utterance.onerror = events.error
  window.speechSynthesis.speak(utterance)
  return () => {
    utterance.onend = null
    utterance.onerror = null
    window.speechSynthesis.cancel()
  }
}
