export function stripForeignSessionNoise(text: string): string;

export function classifyForeignTranscript(input: {
  userTexts?: string[];
  assistantTexts?: string[];
  successfulToolCount?: number;
  sawAbort?: boolean;
}): { verdict: "useful" | "useless"; reasons: string[] };
