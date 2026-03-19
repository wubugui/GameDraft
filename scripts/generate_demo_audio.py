import math
import random
import wave
from pathlib import Path

SAMPLE_RATE = 22050
BASE_DIR = Path(__file__).resolve().parent.parent / "public" / "assets" / "audio"


def clamp(sample: float) -> int:
    sample = max(-1.0, min(1.0, sample))
    return int(sample * 32767)


def write_wav(name: str, duration: float, sample_fn) -> None:
    BASE_DIR.mkdir(parents=True, exist_ok=True)
    total = int(SAMPLE_RATE * duration)
    path = BASE_DIR / name
    with wave.open(str(path), "wb") as wav_file:
      wav_file.setnchannels(1)
      wav_file.setsampwidth(2)
      wav_file.setframerate(SAMPLE_RATE)
      frames = bytearray()
      for i in range(total):
          t = i / SAMPLE_RATE
          frames.extend(clamp(sample_fn(t, i)).to_bytes(2, "little", signed=True))
      wav_file.writeframes(frames)


def smooth_noise(seed: int):
    rng = random.Random(seed)
    current = 0.0

    def next_value(strength: float = 0.03) -> float:
        nonlocal current
        current = current * 0.985 + rng.uniform(-strength, strength)
        return current

    return next_value


def teahouse_roomtone(t: float, _i: int) -> float:
    noise = teahouse_noise()
    low = math.sin(2 * math.pi * 110 * t) * 0.03
    mid = math.sin(2 * math.pi * 220 * t) * 0.015
    flutter = math.sin(2 * math.pi * 0.18 * t) * 0.02
    return low + mid + flutter + noise


def night_wind(t: float, _i: int) -> float:
    noise = alley_noise(0.018)
    wind = math.sin(2 * math.pi * 55 * t) * 0.03
    gust = math.sin(2 * math.pi * 0.11 * t) * 0.05
    return wind + gust + noise


def temple_rumble(t: float, _i: int) -> float:
    noise = temple_noise(0.025)
    drone = math.sin(2 * math.pi * 70 * t) * 0.05
    pulse = math.sin(2 * math.pi * 0.07 * t) * 0.03
    creak = math.sin(2 * math.pi * 420 * t) * max(0.0, math.sin(2 * math.pi * 0.21 * t)) * 0.01
    return drone + pulse + creak + noise


def story_intro(t: float, _i: int) -> float:
    envelope = max(0.0, 1.0 - t / 1.8)
    chime = math.sin(2 * math.pi * 523.25 * t) * 0.26
    overtone = math.sin(2 * math.pi * 783.99 * t) * 0.12
    bed = math.sin(2 * math.pi * 261.63 * t) * 0.05
    return (chime + overtone + bed) * envelope


def iron_box_chime(t: float, _i: int) -> float:
    envelope = max(0.0, 1.0 - t / 1.1)
    metallic = math.sin(2 * math.pi * 660 * t) * 0.22
    metallic += math.sin(2 * math.pi * 990 * t) * 0.12
    metallic += math.sin(2 * math.pi * 1320 * t) * 0.06
    return metallic * envelope


def reveal_sting(t: float, _i: int) -> float:
    envelope = max(0.0, 1.0 - t / 2.1)
    low = math.sin(2 * math.pi * 174.61 * t) * 0.18
    dissonance = math.sin(2 * math.pi * 233.08 * t) * 0.13
    high = math.sin(2 * math.pi * 698.46 * t) * 0.04
    rumble = reveal_noise() * 0.8
    return (low + dissonance + high + rumble) * envelope


teahouse_noise = smooth_noise(11)
alley_noise = smooth_noise(22)
temple_noise = smooth_noise(33)
reveal_noise = smooth_noise(44)


def main() -> None:
    write_wav("teahouse_roomtone.wav", 8.0, teahouse_roomtone)
    write_wav("night_alley_wind.wav", 8.0, night_wind)
    write_wav("temple_rumble.wav", 8.0, temple_rumble)
    write_wav("story_intro.wav", 1.8, story_intro)
    write_wav("iron_box_chime.wav", 1.1, iron_box_chime)
    write_wav("reveal_sting.wav", 2.1, reveal_sting)
    print("demo audio generated")


if __name__ == "__main__":
    main()
