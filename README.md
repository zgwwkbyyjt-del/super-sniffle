# super-sniffle

## Jarvis: a voice assistant

Talk to Jarvis out loud and it talks back, using Claude as its brain.

### Setup
1. Install Python from [python.org](https://www.python.org/downloads/). On Windows, tick **Add Python to PATH**.
2. Install the add-ons:
   ```
   pip install -r requirements.txt
   ```
   (Mac: run `brew install portaudio` first. Linux: `sudo apt install portaudio19-dev`.)
3. Create an API key at [console.anthropic.com](https://console.anthropic.com) and save it:
   - Windows: `setx ANTHROPIC_API_KEY "sk-ant-your-key"`, then reopen the terminal
   - Mac/Linux: `export ANTHROPIC_API_KEY=sk-ant-your-key`

### Run
```
python jarvis.py
```
Start each sentence with "Jarvis", for example: *"Jarvis, what's the time?"*. Say *"Jarvis, goodbye"* to stop.
