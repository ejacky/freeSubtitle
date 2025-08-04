from flask import Flask, request, jsonify, render_template
import whisper
import os
import warnings
import subprocess
import tempfile
import concurrent.futures
import functools
import shutil
import datetime
import random
warnings.filterwarnings("ignore", message="FP16 is not supported on CPU; using FP32 instead")

app = Flask(__name__)
model = whisper.load_model("small")
executor = concurrent.futures.ThreadPoolExecutor(max_workers=4)

@app.route('/upload', methods=['POST'])
async def upload():
    try:
        audio = request.files['audio']
        if not audio:
            return jsonify({"error": "没有接收到音频文件"}), 400
        
        # 保存原始音频文件
        temp_input = tempfile.NamedTemporaryFile(delete=False, suffix='.webm')
        audio.save(temp_input.name)
        temp_input.close()
        
        print(f"📁 保存原始文件: {temp_input.name}, 大小: {os.path.getsize(temp_input.name)} 字节")
        
        # 转换为标准格式
        temp_output = tempfile.NamedTemporaryFile(delete=False, suffix='.wav')
        temp_output.close()

        
        def process_audio(input_name, output_name):
            try:
                # 保存 input_name 和 output_name 到 debug_uploads 目录
                os.makedirs('debug_uploads', exist_ok=True)
                now = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
                rand = random.randint(1000, 9999)
                shutil.copy(input_name, f'debug_uploads/upload_{now}_{rand}.webm')
                print(f"    原始文件: upload_{now}_{rand}.webm")

                print("🔄 开始音频格式转换...")
                result = subprocess.run([
                    'ffmpeg', '-i', input_name, 
                    '-acodec', 'pcm_s16le', 
                    '-ar', '16000', 
                    '-ac', '1', 
                    '-y',
                    output_name
                ], check=True, capture_output=True, text=True)
                print(f"✅ 音频转换成功，输出文件大小: {os.path.getsize(output_name)} 字节")
                print("🎤 开始语音识别...")
                result = model.transcribe(output_name)
                print("✅ 语音识别完成")
                return {"text": result["text"]}
            except subprocess.CalledProcessError as e:
                print(f"❌ 音频转换失败: {e.stderr}")
                return {"error": f"音频转换失败: {e.stderr}"}
            except Exception as e:
                print(f"❌ 转录失败: {str(e)}")
                return {"error": f"转录失败: {str(e)}"}

        
        loop = None
        try:
            import asyncio
            loop = asyncio.get_event_loop()
        except RuntimeError:
            import asyncio
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
        result = await loop.run_in_executor(executor, functools.partial(process_audio, temp_input.name, temp_output.name))
        if 'error' in result:
            return jsonify(result), 500
        return jsonify(result)
    except Exception as e:
        print(f"❌ 处理失败: {str(e)}")
        return jsonify({"error": f"处理失败: {str(e)}"}), 500

@app.route('/')
def index():
    return render_template('index.html')

if __name__ == "__main__":
    app.run(debug=True)
