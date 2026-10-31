// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_ALERT_COOLDOWN_MS,
  _resetAgentAlertForTest,
  playAgentAlert,
} from "./agentAlert";
import { useSettingsStore } from "../store/useSettingsStore";
import type { Settings } from "./bridge";

/** 最小可用 Settings 桩：本套件只关心 agent_alert_sound */
const fakeSettings = (agentAlertSound: boolean): Settings =>
  ({ agent_alert_sound: agentAlertSound }) as unknown as Settings;

class FakeGainNode {
  gain = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
  connect = vi.fn();
}

class FakeOscillatorNode {
  type = "";
  frequency = { value: 0 };
  connect = vi.fn((node: unknown) => node);
  start = vi.fn();
  stop = vi.fn();
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  oscillators: FakeOscillatorNode[] = [];
  state = "running";
  currentTime = 0;
  destination = {};
  resume = vi.fn(async () => {});
  createOscillator = () => {
    const o = new FakeOscillatorNode();
    this.oscillators.push(o);
    return o;
  };
  createGain = () => new FakeGainNode();
  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

let clock = 0;

beforeEach(() => {
  clock = 0;
  FakeAudioContext.instances = [];
  _resetAgentAlertForTest(() => clock);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  useSettingsStore.setState({ settings: fakeSettings(true) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useSettingsStore.setState({ settings: null });
});

describe("playAgentAlert", () => {
  it("首次异常发声；同状态冷却期内不重放", () => {
    expect(playAgentAlert("failed")).toBe(true);
    clock += AGENT_ALERT_COOLDOWN_MS - 1;
    expect(playAgentAlert("failed")).toBe(false);
  });

  it("冷却到期后同状态可再次发声（AudioContext 惰性缓存复用）", () => {
    expect(playAgentAlert("waiting")).toBe(true);
    clock += AGENT_ALERT_COOLDOWN_MS;
    expect(playAgentAlert("waiting")).toBe(true);
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it("跨状态立即重响（waiting→failed 不互相冷却）", () => {
    expect(playAgentAlert("waiting")).toBe(true);
    clock += 1;
    expect(playAgentAlert("failed")).toBe(true);
  });

  it("设置关闭时不发声也不创建 AudioContext", () => {
    useSettingsStore.setState({ settings: fakeSettings(false) });
    expect(playAgentAlert("failed")).toBe(false);
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it("AudioContext 不可用时静默返回 false，不抛错", () => {
    vi.stubGlobal("AudioContext", undefined);
    (window as unknown as { AudioContext?: undefined }).AudioContext = undefined;
    expect(playAgentAlert("failed")).toBe(false);
  });

  it("failed 为低双音、waiting 为中单音", () => {
    expect(playAgentAlert("waiting")).toBe(true);
    clock += AGENT_ALERT_COOLDOWN_MS;
    expect(playAgentAlert("failed")).toBe(true);
    expect(FakeAudioContext.instances).toHaveLength(1);
    const oscs = FakeAudioContext.instances[0].oscillators;
    expect(oscs).toHaveLength(3); // waiting 1 音 + failed 2 音
    expect(oscs[0].frequency.value).toBe(523.25);
    expect(oscs[1].frequency.value).toBe(392.0);
    expect(oscs[2].frequency.value).toBeCloseTo(261.63);
  });
});
