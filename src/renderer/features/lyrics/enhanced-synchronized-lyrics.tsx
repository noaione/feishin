import clsx from 'clsx';
import isElectron from 'is-electron';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import styles from './enhanced-synchronized-lyrics.module.css';

import { LyricLine } from '/@/renderer/features/lyrics/lyric-line';
import {
    useLyricsDisplaySettings,
    useLyricsSettings,
    usePlaybackType,
    usePlayerActions,
    usePlayerStatus,
} from '/@/renderer/store';
import { usePlayerTimestamp } from '/@/renderer/store/timestamp.store';
import { sanitize } from '/@/renderer/utils/sanitize';
import {
    StructuredLyricAgent,
    StructuredLyricCue,
    StructuredLyricCueLine,
    StructuredSyncedLyric,
    SynchronizedLyricsArray,
} from '/@/shared/types/domain-types';
import { PlayerStatus, PlayerType } from '/@/shared/types/types';

const mpvPlayer = isElectron() ? window.api.mpvPlayer : null;
const utils = isElectron() ? window.api.utils : null;
const mpris = isElectron() && utils?.isLinux() ? window.api.mpris : null;
const BREAK_AGENT_ID = '__feishin_break__';
const DEFAULT_ENHANCED_LYRICS_BREAK_THRESHOLD_MS = 1500;

export interface EnhancedSynchronizedLyricsProps extends Omit<StructuredSyncedLyric, 'lyrics'> {
    lyrics: SynchronizedLyricsArray;
    offsetMs?: number;
    pronunciationLyrics?: null | StructuredSyncedLyric;
    settingsKey?: string;
    showAnnotations?: boolean;
    style?: React.CSSProperties;
    translatedLyrics?: null | string;
    translationLyrics?: null | StructuredSyncedLyric;
}

type CueSegment =
    | {
          cue: StructuredLyricCue;
          text: string;
          type: 'cue';
      }
    | {
          text: string;
          type: 'plain';
      };

type RenderState = {
    activeIndexes: number[];
    scrollTargetIndex: number;
    signature: string;
    timeMs: number;
};

const textEncoder = new TextEncoder();

function clamp(value: number) {
    return Math.max(0, Math.min(1, value));
}

function createByteToStringIndex(text: string) {
    const byteToStringIndex = new Map<number, number>();
    let byteOffset = 0;
    let stringIndex = 0;

    byteToStringIndex.set(0, 0);

    for (const char of text) {
        const nextByteOffset = byteOffset + textEncoder.encode(char).length;
        const nextStringIndex = stringIndex + char.length;

        for (let idx = byteOffset; idx < nextByteOffset; idx += 1) {
            byteToStringIndex.set(idx, stringIndex);
        }

        byteOffset = nextByteOffset;
        stringIndex = nextStringIndex;
        byteToStringIndex.set(byteOffset, stringIndex);
    }

    return byteToStringIndex;
}

function findAnnotationCueLine(
    lyric: null | StructuredSyncedLyric | undefined,
    mainLine: StructuredLyricCueLine,
) {
    return lyric?.cueLine?.find((line) => line.index === mainLine.index);
}

function getActiveIndexes(lines: StructuredLyricCueLine[], currentTimeMs: number) {
    return lines.flatMap((line, idx) => (isLineActive(line, currentTimeMs) ? [idx] : []));
}

function getAnnotationText(
    lyric: null | StructuredSyncedLyric | undefined,
    lineIndex: number,
    fallbackLines?: string[],
) {
    if (lyric) return lyric.lyrics[lineIndex]?.[1];
    return fallbackLines?.[lineIndex];
}

function getBackgroundHostIndex(
    backgroundLine: StructuredLyricCueLine,
    activeIndexes: number[],
    primaryCueLines: StructuredLyricCueLine[],
) {
    const overlappingActiveIndexes = activeIndexes.filter((idx) =>
        linesOverlap(primaryCueLines[idx], backgroundLine),
    );

    if (overlappingActiveIndexes.length === 0) return -1;

    return overlappingActiveIndexes.reduce((bestIdx, idx) => {
        const bestDistance = Math.abs(
            getLineStart(primaryCueLines[bestIdx]) - getLineStart(backgroundLine),
        );
        const distance = Math.abs(
            getLineStart(primaryCueLines[idx]) - getLineStart(backgroundLine),
        );

        return distance < bestDistance ? idx : bestIdx;
    });
}

function getBackgroundLineKey(line: StructuredLyricCueLine) {
    return `${line.index}:${line.agentId ?? ''}:${getLineStart(line)}`;
}

function getBreakCueLine(
    previousLine: StructuredLyricCueLine,
    nextLine: StructuredLyricCueLine,
    index: number,
    minGapMs: number,
): null | StructuredLyricCueLine {
    const start = getLineEnd(previousLine) + 1;
    const end = getLineStart(nextLine) - 1;

    if (end - start + 1 < minGapMs) return null;

    return {
        agentId: BREAK_AGENT_ID,
        cue: [
            {
                byteEnd: 2,
                byteStart: 0,
                end,
                start,
                value: '...',
            },
        ],
        end,
        index,
        start,
        value: '...',
    };
}

function getCueProgress(cue: StructuredLyricCue, currentTimeMs: number, fallbackEnd?: number) {
    if (currentTimeMs < cue.start) return 0;

    const effectiveEnd =
        cue.end !== undefined && cue.end > cue.start
            ? cue.end
            : fallbackEnd !== undefined && fallbackEnd > cue.start
              ? fallbackEnd
              : undefined;

    if (effectiveEnd === undefined) return 1;
    return clamp((currentTimeMs - cue.start) / (effectiveEnd - cue.start));
}

function getLineEnd(line: StructuredLyricCueLine) {
    return line.end ?? line.cue.at(-1)?.end ?? line.cue.at(-1)?.start ?? getLineStart(line);
}

function getLineStart(line: StructuredLyricCueLine) {
    return line.start ?? line.cue[0]?.start ?? 0;
}

function getRenderState(
    timeMs: number,
    primaryCueLines: StructuredLyricCueLine[],
    backgroundCueLines: StructuredLyricCueLine[],
): RenderState {
    const activeIndexes = getActiveIndexes(primaryCueLines, timeMs);
    const backgroundSignature = backgroundCueLines
        .flatMap((line) => {
            if (!isLineActive(line, timeMs)) return [];

            const hostIndex = getBackgroundHostIndex(line, activeIndexes, primaryCueLines);
            return hostIndex >= 0 ? [`${hostIndex}:${getBackgroundLineKey(line)}`] : [];
        })
        .join(',');
    const signature = `${activeIndexes.join(',')}|${backgroundSignature}`;

    return {
        activeIndexes,
        scrollTargetIndex: activeIndexes[0] ?? -1,
        signature,
        timeMs,
    };
}

function getStringIndex(
    byteToStringIndex: Map<number, number>,
    byteIndex: number,
    fallback: number,
) {
    return byteToStringIndex.get(byteIndex) ?? fallback;
}

function isBackgroundAgent(
    agentId: string | undefined,
    agents: StructuredLyricAgent[] | undefined,
) {
    if (!agentId) return false;
    if (agentId.startsWith('__nd_bg__')) return true;
    return agents?.find((agent) => agent.id === agentId)?.role === 'bg';
}

function isBreakCueLine(line: StructuredLyricCueLine) {
    return line.agentId === BREAK_AGENT_ID;
}

function isLineActive(line: StructuredLyricCueLine, currentTimeMs: number) {
    return currentTimeMs >= getLineStart(line) && currentTimeMs <= getLineEnd(line);
}

function linesOverlap(a: StructuredLyricCueLine, b: StructuredLyricCueLine) {
    return getLineStart(a) <= getLineEnd(b) && getLineStart(b) <= getLineEnd(a);
}

function splitCueLine(line: StructuredLyricCueLine): CueSegment[] {
    const byteToStringIndex = createByteToStringIndex(line.value);
    const segments: CueSegment[] = [];
    let cursor = 0;

    for (const cue of [...line.cue].sort((a, b) => a.byteStart - b.byteStart)) {
        const start = getStringIndex(byteToStringIndex, cue.byteStart, cursor);
        const end = getStringIndex(byteToStringIndex, cue.byteEnd + 1, line.value.length);

        if (start > cursor) {
            segments.push({ text: line.value.slice(cursor, start), type: 'plain' });
        }

        segments.push({
            cue,
            text: start < end ? line.value.slice(start, end) : cue.value,
            type: 'cue',
        });

        cursor = Math.max(cursor, end);
    }

    if (cursor < line.value.length) {
        segments.push({ text: line.value.slice(cursor), type: 'plain' });
    }

    return segments;
}

function updateCueProgressNodes(currentTimeMs: number, nodes: HTMLElement[]) {
    for (const node of nodes) {
        const start = Number(node.dataset.cueStart);
        const end = node.dataset.cueEnd ? Number(node.dataset.cueEnd) : undefined;
        const lineEnd = node.dataset.cueLineEnd ? Number(node.dataset.cueLineEnd) : undefined;

        if (!Number.isFinite(start)) continue;

        let progress = currentTimeMs >= start ? 1 : 0;

        if (end !== undefined && Number.isFinite(end)) {
            progress = getCueProgress(
                { byteEnd: 0, byteStart: 0, end, start, value: '' },
                currentTimeMs,
                lineEnd,
            );
        } else if (lineEnd !== undefined && Number.isFinite(lineEnd)) {
            progress = getCueProgress(
                { byteEnd: 0, byteStart: 0, start, value: '' },
                currentTimeMs,
                lineEnd,
            );
        }

        node.style.setProperty('--cue-progress', progress.toString());
    }
}

function withBreakCueLines(lines: StructuredLyricCueLine[], minGapMs: number) {
    return lines.flatMap((line, idx) => {
        if (idx === 0) return [line];

        const breakLine = getBreakCueLine(lines[idx - 1], line, -idx, minGapMs);
        return breakLine ? [breakLine, line] : [line];
    });
}

const CueText = ({
    cueOnly,
    currentTimeMs,
    line,
}: {
    cueOnly?: boolean;
    currentTimeMs: number;
    line: StructuredLyricCueLine;
}) => {
    const segments = useMemo(() => splitCueLine(line), [line]);

    return (
        <span className={styles.cueText}>
            {segments.map((segment, idx) => {
                if (segment.type === 'plain') {
                    if (cueOnly && segment.text.trim().length > 0) {
                        return null;
                    }

                    return (
                        <span
                            className={styles.plainText}
                            dangerouslySetInnerHTML={{ __html: sanitize(segment.text) }}
                            key={idx}
                        />
                    );
                }

                return (
                    <span
                        className={styles.cueSpan}
                        data-cue-end={segment.cue.end}
                        data-cue-line-end={line.end}
                        data-cue-start={segment.cue.start}
                        key={`${segment.cue.start}-${segment.cue.byteStart}-${idx}`}
                        style={
                            {
                                '--cue-progress': getCueProgress(
                                    segment.cue,
                                    currentTimeMs,
                                    line.end,
                                ),
                            } as React.CSSProperties
                        }
                    >
                        <span
                            className={styles.cueBase}
                            dangerouslySetInnerHTML={{ __html: sanitize(segment.text) }}
                        />
                        <span
                            className={styles.cueFill}
                            dangerouslySetInnerHTML={{ __html: sanitize(segment.text) }}
                        />
                    </span>
                );
            })}
        </span>
    );
};

const PlainAnnotation = ({ text }: { text: string }) => (
    <span dangerouslySetInnerHTML={{ __html: sanitize(text) }} />
);

export const EnhancedSynchronizedLyrics = ({
    agents,
    artist,
    cueLine,
    name,
    offsetMs,
    pronunciationLyrics,
    remote,
    settingsKey = 'default',
    showAnnotations,
    source,
    style,
    translatedLyrics,
    translationLyrics,
}: EnhancedSynchronizedLyricsProps) => {
    const playbackType = usePlaybackType();
    const lyricsSettings = useLyricsSettings();
    const displaySettings = useLyricsDisplaySettings(settingsKey);
    const settings = {
        ...lyricsSettings,
        fontSize:
            displaySettings.fontSize && displaySettings.fontSize !== 0
                ? displaySettings.fontSize
                : 24,
        gap: displaySettings.gap && displaySettings.gap !== 0 ? displaySettings.gap : 24,
        opacityNonActive: displaySettings.opacityNonActive,
        scaleNonActive:
            displaySettings.scaleNonActive && displaySettings.scaleNonActive !== 0
                ? displaySettings.scaleNonActive
                : 0.95,
    };
    const enhancedLyricsBreakThresholdMs =
        settings.enhancedLyricsBreakThresholdMs ?? DEFAULT_ENHANCED_LYRICS_BREAK_THRESHOLD_MS;
    const { mediaSeekToTimestamp } = usePlayerActions();
    const playbackStatus = usePlayerStatus();
    const timestamp = usePlayerTimestamp();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const cueProgressNodesRef = useRef<HTMLElement[]>([]);
    const followRef = useRef(settings.follow);
    const playbackTimeRef = useRef(timestamp * 1000 + (offsetMs ?? 0));
    const programmaticScrollRef = useRef(false);
    const renderSignatureRef = useRef('');
    const scrollTimeoutRef = useRef<null | ReturnType<typeof setTimeout>>(null);
    const userScrollingRef = useRef(false);

    const sortedCueLines = useMemo(
        () => [...(cueLine ?? [])].sort((a, b) => getLineStart(a) - getLineStart(b)),
        [cueLine],
    );

    const backgroundCueLines = useMemo(
        () => sortedCueLines.filter((line) => isBackgroundAgent(line.agentId, agents)),
        [agents, sortedCueLines],
    );

    const primaryCueLines = useMemo(() => {
        const primary = sortedCueLines.filter((line) => !isBackgroundAgent(line.agentId, agents));
        return withBreakCueLines(
            primary.length > 0 ? primary : sortedCueLines,
            enhancedLyricsBreakThresholdMs,
        );
    }, [agents, enhancedLyricsBreakThresholdMs, sortedCueLines]);

    const externalTranslationLines = useMemo(
        () => translatedLyrics?.split('\n'),
        [translatedLyrics],
    );

    const [renderState, setRenderState] = useState<RenderState>(() =>
        getRenderState(playbackTimeRef.current, primaryCueLines, backgroundCueLines),
    );

    const activeIndexes = renderState.activeIndexes;
    const renderTimeMs = renderState.timeMs;
    const scrollTargetIndex = renderState.scrollTargetIndex;

    const handleSeek = useCallback(
        (time: number) => {
            if (playbackType === PlayerType.LOCAL && mpvPlayer) {
                mpvPlayer.seekTo(time);
            } else {
                mpris?.updateSeek(time);
                mediaSeekToTimestamp(time);
            }
        },
        [mediaSeekToTimestamp, playbackType],
    );

    useEffect(() => {
        followRef.current = settings.follow;
    }, [settings.follow]);

    const refreshCueProgressNodes = useCallback(() => {
        const container = containerRef.current;
        if (!container) return;

        cueProgressNodesRef.current = Array.from(
            container.querySelectorAll<HTMLElement>(
                '[data-enhanced-active="true"] [data-cue-start]',
            ),
        );
        updateCueProgressNodes(playbackTimeRef.current, cueProgressNodesRef.current);
    }, []);

    useEffect(() => {
        let animationFrame: number | undefined;
        const effectiveOffsetMs = offsetMs ?? 0;
        const baseTimeMs = timestamp * 1000 + effectiveOffsetMs;
        const basePerformanceTime = performance.now();

        const syncRenderState = (timeMs: number) => {
            playbackTimeRef.current = timeMs;
            const nextRenderState = getRenderState(timeMs, primaryCueLines, backgroundCueLines);

            if (nextRenderState.signature !== renderSignatureRef.current) {
                renderSignatureRef.current = nextRenderState.signature;
                setRenderState(nextRenderState);
            }
        };

        if (playbackStatus !== PlayerStatus.PLAYING) {
            syncRenderState(baseTimeMs);
            updateCueProgressNodes(baseTimeMs, cueProgressNodesRef.current);
            return undefined;
        }

        const update = () => {
            const now = performance.now();
            const timeMs = baseTimeMs + now - basePerformanceTime;

            playbackTimeRef.current = timeMs;
            updateCueProgressNodes(timeMs, cueProgressNodesRef.current);
            syncRenderState(timeMs);

            animationFrame = requestAnimationFrame(update);
        };

        update();

        return () => {
            if (animationFrame !== undefined) {
                cancelAnimationFrame(animationFrame);
            }
        };
    }, [backgroundCueLines, offsetMs, playbackStatus, primaryCueLines, timestamp]);

    useEffect(() => {
        renderSignatureRef.current = renderState.signature;
        refreshCueProgressNodes();
    }, [refreshCueProgressNodes, renderState.signature, showAnnotations]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const handleScroll = () => {
            if (programmaticScrollRef.current) return;

            userScrollingRef.current = true;

            if (scrollTimeoutRef.current) {
                clearTimeout(scrollTimeoutRef.current);
            }

            scrollTimeoutRef.current = setTimeout(() => {
                userScrollingRef.current = false;
            }, 3000);
        };

        container.addEventListener('scroll', handleScroll, { passive: true });

        return () => {
            container.removeEventListener('scroll', handleScroll);
            if (scrollTimeoutRef.current) {
                clearTimeout(scrollTimeoutRef.current);
            }
        };
    }, []);

    useEffect(() => {
        if (scrollTargetIndex < 0 || !followRef.current || userScrollingRef.current) return;

        const container = containerRef.current;
        const activeLine = document.getElementById(`enhanced-lyric-${scrollTargetIndex}`);

        if (!container || !activeLine) return;

        const offsetTop = activeLine.offsetTop - container.clientHeight / 2;
        programmaticScrollRef.current = true;
        container.scroll({ behavior: 'smooth', top: offsetTop });

        const timer = setTimeout(() => {
            programmaticScrollRef.current = false;
        }, 600);

        return () => clearTimeout(timer);
    }, [scrollTargetIndex]);

    useEffect(() => {
        if (scrollTargetIndex < 0 || !followRef.current || userScrollingRef.current) {
            return undefined;
        }

        const frame = requestAnimationFrame(() => {
            const container = containerRef.current;
            const activeLine = document.getElementById(`enhanced-lyric-${scrollTargetIndex}`);

            if (!container || !activeLine) return;

            const offsetTop = activeLine.offsetTop - container.clientHeight / 2;
            programmaticScrollRef.current = true;
            container.scroll({ behavior: 'smooth', top: offsetTop });
            setTimeout(() => {
                programmaticScrollRef.current = false;
            }, 600);
        });

        return () => cancelAnimationFrame(frame);
    }, [scrollTargetIndex, showAnnotations, translatedLyrics, translationLyrics]);

    const hideScrollbar = () => {
        containerRef.current?.classList.add('hide-scrollbar');
    };

    const showScrollbar = () => {
        containerRef.current?.classList.remove('hide-scrollbar');
    };

    return (
        <div
            className={clsx(styles.container, 'enhanced-synchronized-lyrics overlay-scrollbar')}
            onMouseEnter={showScrollbar}
            onMouseLeave={hideScrollbar}
            ref={containerRef}
            style={
                {
                    '--lyric-alignment': settings.alignment,
                    '--lyric-opacity': settings.opacityNonActive,
                    '--lyric-scale': settings.scaleNonActive,
                    '--lyric-scale-origin': settings.alignment,
                    gap: `${settings.gap}px`,
                    ...style,
                } as React.CSSProperties
            }
        >
            {settings.showProvider && source && (
                <LyricLine
                    alignment={settings.alignment}
                    className="lyric-credit"
                    fontSize={settings.fontSize}
                    text={`Provided by ${source}`}
                />
            )}
            {settings.showMatch && remote && (
                <LyricLine
                    alignment={settings.alignment}
                    className="lyric-credit"
                    fontSize={settings.fontSize}
                    text={`"${name} by ${artist}"`}
                />
            )}
            {primaryCueLines.map((line, idx) => {
                const isActive = activeIndexes.includes(idx);
                const isBreak = isBreakCueLine(line);
                const annotationFontSize = Math.max(12, settings.fontSize * 0.58);
                const backgroundFontSize = Math.max(12, settings.fontSize * 0.7);
                const translationCueLine = isBreak
                    ? undefined
                    : findAnnotationCueLine(translationLyrics, line);
                const pronunciationCueLine = isBreak
                    ? undefined
                    : findAnnotationCueLine(pronunciationLyrics, line);
                const translationText = isBreak
                    ? undefined
                    : getAnnotationText(translationLyrics, line.index, externalTranslationLines);
                const pronunciationText = isBreak
                    ? undefined
                    : getAnnotationText(pronunciationLyrics, line.index);
                const activeBackgroundLines =
                    isActive && !isBreak
                        ? backgroundCueLines.filter(
                              (backgroundLine) =>
                                  isLineActive(backgroundLine, renderTimeMs) &&
                                  getBackgroundHostIndex(
                                      backgroundLine,
                                      activeIndexes,
                                      primaryCueLines,
                                  ) === idx,
                          )
                        : [];

                return (
                    <div
                        className={clsx(styles.line, {
                            [styles.active]: isActive,
                            [styles.breakLine]: isBreak,
                        })}
                        data-enhanced-active={isActive ? 'true' : undefined}
                        id={`enhanced-lyric-${idx}`}
                        key={`${line.index}-${line.agentId ?? 'main'}-${getLineStart(line)}`}
                        onClick={() => {
                            const time = getLineStart(line);
                            if (time > 0 && Number.isFinite(time)) {
                                handleSeek(time / 1000);
                            }
                        }}
                        style={{ fontSize: settings.fontSize }}
                    >
                        {showAnnotations && translationCueLine ? (
                            <div
                                className={styles.annotation}
                                style={{ fontSize: annotationFontSize }}
                            >
                                <CueText
                                    cueOnly={translationCueLine.cue.length > 0}
                                    currentTimeMs={renderTimeMs}
                                    line={translationCueLine}
                                />
                            </div>
                        ) : null}
                        {showAnnotations && !translationCueLine && translationText ? (
                            <div
                                className={styles.annotation}
                                style={{ fontSize: annotationFontSize }}
                            >
                                <PlainAnnotation text={translationText} />
                            </div>
                        ) : null}
                        {showAnnotations && pronunciationCueLine ? (
                            <div
                                className={styles.annotation}
                                style={{ fontSize: annotationFontSize }}
                            >
                                <CueText
                                    cueOnly={pronunciationCueLine.cue.length > 0}
                                    currentTimeMs={renderTimeMs}
                                    line={pronunciationCueLine}
                                />
                            </div>
                        ) : null}
                        {showAnnotations && !pronunciationCueLine && pronunciationText ? (
                            <div
                                className={styles.annotation}
                                style={{ fontSize: annotationFontSize }}
                            >
                                <PlainAnnotation text={pronunciationText} />
                            </div>
                        ) : null}
                        <CueText
                            cueOnly={line.cue.length > 0}
                            currentTimeMs={renderTimeMs}
                            line={line}
                        />
                        {activeBackgroundLines.map((backgroundLine) => (
                            <div
                                className={styles.background}
                                key={`${backgroundLine.index}-${
                                    backgroundLine.agentId ?? 'bg'
                                }-${getLineStart(backgroundLine)}`}
                                style={{ fontSize: backgroundFontSize }}
                            >
                                <CueText
                                    cueOnly={backgroundLine.cue.length > 0}
                                    currentTimeMs={renderTimeMs}
                                    line={backgroundLine}
                                />
                            </div>
                        ))}
                    </div>
                );
            })}
        </div>
    );
};
