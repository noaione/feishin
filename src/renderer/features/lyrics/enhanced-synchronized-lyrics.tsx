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
const CUE_RENDER_INTERVAL_MS = 33;

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

function getAnnotationText(
    lyric: null | StructuredSyncedLyric | undefined,
    lineIndex: number,
    fallbackLines?: string[],
) {
    if (lyric) return lyric.lyrics[lineIndex]?.[1];
    return fallbackLines?.[lineIndex];
}

function getCueProgress(cue: StructuredLyricCue, currentTimeMs: number) {
    if (currentTimeMs < cue.start) return 0;
    if (cue.end === undefined || cue.end <= cue.start) return 1;
    return clamp((currentTimeMs - cue.start) / (cue.end - cue.start));
}

function getLineEnd(line: StructuredLyricCueLine) {
    return line.end ?? line.cue.at(-1)?.end ?? line.cue.at(-1)?.start ?? getLineStart(line);
}

function getLineStart(line: StructuredLyricCueLine) {
    return line.start ?? line.cue[0]?.start ?? 0;
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
                        key={`${segment.cue.start}-${segment.cue.byteStart}-${idx}`}
                        style={
                            {
                                '--cue-progress': getCueProgress(segment.cue, currentTimeMs),
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
    const { mediaSeekToTimestamp } = usePlayerActions();
    const playbackStatus = usePlayerStatus();
    const timestamp = usePlayerTimestamp();
    const [currentTimeMs, setCurrentTimeMs] = useState(timestamp * 1000 + (offsetMs ?? 0));
    const containerRef = useRef<HTMLDivElement | null>(null);
    const followRef = useRef(settings.follow);
    const programmaticScrollRef = useRef(false);
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
        return primary.length > 0 ? primary : sortedCueLines;
    }, [agents, sortedCueLines]);

    const externalTranslationLines = useMemo(
        () => translatedLyrics?.split('\n'),
        [translatedLyrics],
    );

    const latestStartedIndex = useMemo(() => {
        let index = -1;

        for (let idx = 0; idx < primaryCueLines.length; idx += 1) {
            if (currentTimeMs < getLineStart(primaryCueLines[idx])) {
                break;
            }
            index = idx;
        }

        return index;
    }, [currentTimeMs, primaryCueLines]);

    const activeIndexes = useMemo(() => {
        const indexes = primaryCueLines.flatMap((line, idx) =>
            isLineActive(line, currentTimeMs) ? [idx] : [],
        );

        if (indexes.length > 0) return indexes;
        return latestStartedIndex >= 0 ? [latestStartedIndex] : [];
    }, [currentTimeMs, latestStartedIndex, primaryCueLines]);

    const scrollTargetIndex = activeIndexes[0] ?? -1;

    const getBackgroundHostIndex = useCallback(
        (backgroundLine: StructuredLyricCueLine) => {
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
        },
        [activeIndexes, primaryCueLines],
    );

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

    useEffect(() => {
        let animationFrame: number | undefined;
        const effectiveOffsetMs = offsetMs ?? 0;
        const baseTimeMs = timestamp * 1000 + effectiveOffsetMs;
        const basePerformanceTime = performance.now();
        let lastRenderTime = 0;

        if (playbackStatus !== PlayerStatus.PLAYING) {
            setCurrentTimeMs(baseTimeMs);
            return undefined;
        }

        const update = () => {
            const now = performance.now();

            if (now - lastRenderTime >= CUE_RENDER_INTERVAL_MS) {
                lastRenderTime = now;
                setCurrentTimeMs(baseTimeMs + now - basePerformanceTime);
            }

            animationFrame = requestAnimationFrame(update);
        };

        update();

        return () => {
            if (animationFrame !== undefined) {
                cancelAnimationFrame(animationFrame);
            }
        };
    }, [offsetMs, playbackStatus, timestamp]);

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
                const annotationFontSize = Math.max(12, settings.fontSize * 0.58);
                const backgroundFontSize = Math.max(12, settings.fontSize * 0.7);
                const translationCueLine = findAnnotationCueLine(translationLyrics, line);
                const pronunciationCueLine = findAnnotationCueLine(pronunciationLyrics, line);
                const translationText = getAnnotationText(
                    translationLyrics,
                    line.index,
                    externalTranslationLines,
                );
                const pronunciationText = getAnnotationText(pronunciationLyrics, line.index);
                const activeBackgroundLines = isActive
                    ? backgroundCueLines.filter(
                          (backgroundLine) =>
                              isLineActive(backgroundLine, currentTimeMs) &&
                              getBackgroundHostIndex(backgroundLine) === idx,
                      )
                    : [];

                return (
                    <div
                        className={clsx(styles.line, { [styles.active]: isActive })}
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
                                    currentTimeMs={currentTimeMs}
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
                                    currentTimeMs={currentTimeMs}
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
                            currentTimeMs={currentTimeMs}
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
                                    currentTimeMs={currentTimeMs}
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
