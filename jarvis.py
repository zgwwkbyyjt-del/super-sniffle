# jarvis.py - your own voice assistant
import datetime
import webbrowser

import anthropic
import pyttsx3
import speech_recognition as sr

client = anthropic.Anthropic()  # finds your ANTHROPIC_API_KEY automatically
voice = pyttsx3.init()
ears = sr.Recognizer()

SYSTEM = "You are Jarvis, a helpful, witty voice assistant. Answer in one to three short sentences."
history = []


# THE MOUTH: say something out loud
def speak(text):
    print("Jarvis:", text)
    voice.say(text)
    voice.runAndWait()


# THE EARS: listen to the microphone and turn speech into text
def listen():
    with sr.Microphone() as mic:
        ears.adjust_for_ambient_noise(mic, duration=0.5)
        print("Listening...")
        audio = ears.listen(mic)
    try:
        return ears.recognize_google(audio)
    except sr.UnknownValueError:
        return ""


# THE BRAIN: ask Claude what to say
def think(text):
    history.append({"role": "user", "content": text})
    reply = client.messages.create(
        model="claude-sonnet-5-5",
        max_tokens=300,
        system=SYSTEM,
        messages=history,
    )
    answer = reply.content[0].text
    history.append({"role": "assistant", "content": answer})
    return answer


# THE HANDS: small jobs Jarvis does by itself
def do_task(text):
    t = text.lower()
    if "time" in t:
        return "It's " + datetime.datetime.now().strftime("%I:%M %p")
    if "open youtube" in t:
        webbrowser.open("https://youtube.com")
        return "Opening YouTube."
    return None


# THE MAIN LOOP: keep listening for "Jarvis"
speak("Jarvis online. Say Jarvis, then your request.")
while True:
    heard = listen()
    if not heard.lower().startswith("jarvis"):
        continue
    request = heard[len("jarvis"):].strip(" ,")
    if not request:
        speak("Yes?")
        request = listen()
    print("You:", request)
    if "goodbye" in request.lower():
        speak("Goodbye.")
        break
    speak(do_task(request) or think(request))
