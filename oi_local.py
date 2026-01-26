import json
import os
import traceback
from interpreter import interpreter as oi

# --- НАСТРОЙКИ OPENROUTER ---

# 1. Базовый URL для OpenRouter
oi.llm.api_base = "https://openrouter.ai/api/v1"

# Файл, где будет храниться память
DB_PATH = "ai_memory.json"

# 2. Модель (Baidu Ernie через OpenRouter)
oi.llm.model = "openrouter/baidu/ernie-4.5-300b-a47b"

# 3. Твой API-ключ от OpenRouter
oi.llm.api_key = "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"

# 4. Дополнительные заголовки (OpenRouter часто их просит для рейтинга)
oi.llm.extra_headers = {
    "HTTP-Referer": "http://localhost:3000",  # Можно оставить так
    "X-Title": "My Open Interpreter",
}

# --- ПОВЕДЕНИЕ ---
oi.auto_run = True
oi.offline = False  # Теперь ставим False, так как нужен интернет для OpenRouter
oi.llm.context_window = 128000
oi.llm.max_tokens = 4096

# --- ЛОГИКА ПАМЯТИ ---
def load_memory():
    if os.path.exists(DB_PATH):
        with open(DB_PATH, "r", encoding="utf-8") as f:
            oi.messages = json.load(f)
            print(f"--- Контекст загружен ({len(oi.messages)} сообщений) ---")

def save_memory():
    with open(DB_PATH, "w", encoding="utf-8") as f:
        json.dump(oi.messages, f, indent=4, ensure_ascii=False)
    print("--- Контекст сохранен в ai_memory.json ---")

# --- ЛОГИРОВАНИЕ ---
def start_with_logging():
    load_memory()
    try:
        print("Бот запущен. Введи команду...")
        oi.chat()
    except Exception:
        print("\n" + "=" * 50)
        print("ПРОИЗОШЛА ОШИБКА ПРИ РАБОТЕ ЧАТА:")
        print("=" * 50)
        traceback.print_exc()

        with open("error_log.txt", "a", encoding="utf-8") as f:
            f.write("\n--- NEW CRASH ---\n")
            traceback.print_exc(file=f)
        print("=" * 50)
        print("Детали ошибки сохранены в файл error_log.txt")
        input("Нажми Enter, чтобы закрыть...")
    finally:
        save_memory()

if __name__ == "__main__":
    start_with_logging()