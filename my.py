from flask import Flask, request, jsonify
import whisper
import os

app = Flask(__name__)
model = whisper.load_model("small")

@app.route('/upload', methods=['POST'])
def upload():
    audio = request.files['audio']
    audio_path = 'temp.webm'
    audio.save(audio_path)

    result = model.transcribe(audio_path)
    os.remove(audio_path)

    return jsonify({"text": result["text"]})

if __name__ == "__main__":
    app.run(debug=True)
