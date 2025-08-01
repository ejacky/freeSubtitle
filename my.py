from flask import Flask, request, jsonify, render_template
import whisper
import os
import warnings
import subprocess
import tempfile
warnings.filterwarnings("ignore", message="FP16 is not supported on CPU; using FP32 instead")

app = Flask(__name__)
model = whisper.load_model("small")

@app.route('/upload', methods=['POST'])
def upload():
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
        
        try:
            # 使用ffmpeg转换音频格式
            print("🔄 开始音频格式转换...")
            result = subprocess.run([
                'ffmpeg', '-i', temp_input.name, 
                '-acodec', 'pcm_s16le', 
                '-ar', '16000', 
                '-ac', '1', 
                '-y',  # 覆盖输出文件
                temp_output.name
            ], check=True, capture_output=True, text=True)
            
            print(f"✅ 音频转换成功，输出文件大小: {os.path.getsize(temp_output.name)} 字节")
            
            # 使用转换后的WAV文件进行转录
            print("🎤 开始语音识别...")
            result = model.transcribe(temp_output.name)
            print("✅ 语音识别完成")
            
        except subprocess.CalledProcessError as e:
            print(f"❌ 音频转换失败: {e.stderr}")
            return jsonify({"error": f"音频转换失败: {e.stderr}"}), 500
        except Exception as e:
            print(f"❌ 转录失败: {str(e)}")
            return jsonify({"error": f"转录失败: {str(e)}"}), 500
        finally:
            # 清理临时文件
            try:
                os.unlink(temp_input.name)
                os.unlink(temp_output.name)
                print("🧹 清理临时文件完成")
            except:
                pass
        
        return jsonify({"text": result["text"]})
        
    except Exception as e:
        print(f"❌ 处理失败: {str(e)}")
        return jsonify({"error": f"处理失败: {str(e)}"}), 500

@app.route('/')
def index():
    return render_template('index.html')

if __name__ == "__main__":
    app.run(debug=True)
