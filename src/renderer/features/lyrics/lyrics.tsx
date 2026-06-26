import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './lyrics.module.css';

import { queryKeys } from '/@/renderer/api/query-keys';
import { translateLyrics } from '/@/renderer/features/lyrics/api/lyric-translate';
import {
    computeSelectedFromResult,
    getDisplayOffset,
    getSelectableStructuredLyrics,
    isMainStructuredLyric,
    lyricsQueries,
    type LyricsQueryResult,
} from '/@/renderer/features/lyrics/api/lyrics-api';
import { openLyricsExportModal } from '/@/renderer/features/lyrics/components/lyrics-export-form';
import {
    EnhancedSynchronizedLyrics,
    EnhancedSynchronizedLyricsProps,
} from '/@/renderer/features/lyrics/enhanced-synchronized-lyrics';
import {
    useFuriganaLyrics,
    useRomajiLyrics,
} from '/@/renderer/features/lyrics/hooks/use-furigana-lyrics';
import { LyricsActions } from '/@/renderer/features/lyrics/lyrics-actions';
import {
    SynchronizedLyrics,
    SynchronizedLyricsProps,
} from '/@/renderer/features/lyrics/synchronized-lyrics';
import {
    UnsynchronizedLyrics,
    UnsynchronizedLyricsProps,
} from '/@/renderer/features/lyrics/unsynchronized-lyrics';
import { openLyricsSettingsModal } from '/@/renderer/features/lyrics/utils/open-lyrics-settings-modal';
import { usePlayerEvents } from '/@/renderer/features/player/audio-player/hooks/use-player-events';
import { useIsRadioActive } from '/@/renderer/features/radio/hooks/use-radio-player';
import { ComponentErrorBoundary } from '/@/renderer/features/shared/components/component-error-boundary';
import { queryClient } from '/@/renderer/lib/react-query';
import { useLyricsSettings, usePlayerSong } from '/@/renderer/store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Center } from '/@/shared/components/center/center';
import { Group } from '/@/shared/components/group/group';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { Text } from '/@/shared/components/text/text';
import {
    FullLyricsMetadata,
    LyricsOverride,
    StructuredLyric,
    StructuredSyncedLyric,
} from '/@/shared/types/domain-types';

type LyricsProps = {
    fadeOutNoLyricsMessage?: boolean;
    settingsKey?: string;
};

const hasEnhancedCueLine = (
    lyric: null | StructuredLyric | { lyrics?: unknown },
): lyric is StructuredSyncedLyric => {
    return Boolean(
        lyric && 'synced' in lyric && lyric.synced && 'cueLine' in lyric && lyric.cueLine?.length,
    );
};

const isStructuredSyncedLyric = (
    lyric: StructuredLyric | undefined,
): lyric is StructuredSyncedLyric => {
    return Boolean(lyric?.synced);
};

const lineStartsMatch = (a: StructuredSyncedLyric, b: StructuredSyncedLyric) => {
    if (a.lyrics.length !== b.lyrics.length) return false;
    return a.lyrics.every(([start], idx) => start === b.lyrics[idx]?.[0]);
};

const findAnnotationLyric = (
    lyrics: FullLyricsMetadata | null | StructuredLyric[] | undefined,
    selected: null | StructuredLyric,
    kind: 'pronunciation' | 'translation',
) => {
    if (!selected || !Array.isArray(lyrics) || !isStructuredSyncedLyric(selected)) return null;

    const candidates = lyrics.filter(
        (lyric): lyric is StructuredSyncedLyric =>
            lyric.kind === kind && isStructuredSyncedLyric(lyric),
    );

    return (
        candidates.find((candidate) => lineStartsMatch(selected, candidate)) ??
        candidates.find((candidate) => candidate.lyrics.length === selected.lyrics.length) ??
        candidates[0] ??
        null
    );
};

export const Lyrics = ({ fadeOutNoLyricsMessage = true, settingsKey = 'default' }: LyricsProps) => {
    const currentSong = usePlayerSong();
    const isRadioActive = useIsRadioActive();

    const isLyricsDisabled = isRadioActive;

    const {
        enableAutoTranslation,
        enableFurigana,
        enableRomaji,
        preferLocalLyrics,
        translationApiKey,
        translationApiProvider,
        translationTargetLanguage,
    } = useLyricsSettings();
    const { t } = useTranslation();
    const [index, setIndexState] = useState(0);
    const [translatedLyrics, setTranslatedLyrics] = useState<null | string>(null);
    const [showAnnotations, setShowAnnotations] = useState(false);
    const [pendingSongId, setPendingSongId] = useState<string | undefined>(currentSong?.id);
    const lyricsFetchTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const previousSongIdRef = useRef<string | undefined>(currentSong?.id);

    useEffect(() => {
        const currentSongId = currentSong?.id;
        const previousSongId = previousSongIdRef.current;

        if (currentSongId === previousSongId) {
            return;
        }

        previousSongIdRef.current = currentSongId;
        setPendingSongId(undefined);

        if (!currentSongId) {
            return;
        }

        clearTimeout(lyricsFetchTimeoutRef.current);
        lyricsFetchTimeoutRef.current = setTimeout(() => {
            setPendingSongId(currentSongId);
        }, 500);

        return () => {
            clearTimeout(lyricsFetchTimeoutRef.current);
        };
    }, [currentSong?.id]);

    const lyricsKey = useMemo(() => {
        if (!currentSong?._serverId || !currentSong?.id) return null;
        return queryKeys.songs.lyrics(currentSong._serverId, { songId: currentSong.id });
    }, [currentSong]);

    const { data, isLoading } = useQuery(
        lyricsQueries.songLyrics(
            {
                options: {
                    enabled:
                        !!pendingSongId && pendingSongId === currentSong?.id && !isLyricsDisabled,
                },
                query: { songId: currentSong?.id || '' },
                serverId: currentSong?._serverId || '',
            },
            currentSong,
        ),
    );

    const indexToUse = data?.selectedStructuredIndex ?? index;
    useEffect(() => {
        if (data != null) setIndexState(data.selectedStructuredIndex);
    }, [data]);

    const { selected: lyrics, selectedSynced: synced } = useMemo(() => {
        if (!data) return { selected: null, selectedSynced: false };
        return computeSelectedFromResult(data, preferLocalLyrics, indexToUse);
    }, [data, indexToUse, preferLocalLyrics]);
    const localLyrics = data?.local;

    const { data: furiganaConvertedLyrics } = useFuriganaLyrics(
        lyrics?.lyrics,
        !!enableFurigana && !hasEnhancedCueLine(lyrics),
    );
    const { data: romajiConvertedLyrics } = useRomajiLyrics(
        lyrics?.lyrics,
        !!enableRomaji && !hasEnhancedCueLine(lyrics),
    );

    const displayLyrics = useMemo(() => {
        if (isLyricsDisabled || !lyrics) return null;
        if (enableFurigana && !hasEnhancedCueLine(lyrics) && furiganaConvertedLyrics) {
            return { ...lyrics, lyrics: furiganaConvertedLyrics };
        }
        return lyrics;
    }, [enableFurigana, isLyricsDisabled, lyrics, furiganaConvertedLyrics]);

    const selectedStructuredLyric = useMemo(() => {
        if (!Array.isArray(localLyrics)) return null;
        return getSelectableStructuredLyrics(localLyrics)[indexToUse] ?? null;
    }, [indexToUse, localLyrics]);

    const serverPronunciationLyrics = useMemo(
        () => findAnnotationLyric(localLyrics, selectedStructuredLyric, 'pronunciation'),
        [localLyrics, selectedStructuredLyric],
    );

    const serverTranslationLyrics = useMemo(
        () => findAnnotationLyric(localLyrics, selectedStructuredLyric, 'translation'),
        [localLyrics, selectedStructuredLyric],
    );

    const hasServerAnnotations = Boolean(serverPronunciationLyrics || serverTranslationLyrics);
    const shouldUseExternalTranslation = !serverTranslationLyrics;
    const canFetchExternalTranslation = Boolean(
        shouldUseExternalTranslation && translationApiProvider && translationApiKey,
    );

    const currentOffsetMs = useMemo(() => {
        if (!data) return 0;
        return getDisplayOffset(lyrics, data.selectedOffsetMs, indexToUse, data.local);
    }, [data, indexToUse, lyrics]);

    const displayOffsetMs = isLyricsDisabled ? 0 : currentOffsetMs;

    const handleOnSearchOverride = useCallback(
        (params: LyricsOverride) => {
            if (!lyricsKey) return;
            queryClient.setQueryData<LyricsQueryResult>(lyricsKey, (prev) =>
                prev ? { ...prev, overrideSelection: params } : prev,
            );
            queryClient.invalidateQueries({ queryKey: lyricsKey });
        },
        [lyricsKey],
    );

    const handleUpdateOffset = useCallback(
        (offsetMs: number) => {
            if (!currentSong || !lyricsKey) return;

            queryClient.setQueryData<LyricsQueryResult>(lyricsKey, (prev) => {
                if (!prev) return prev;
                const updated = { ...prev, selectedOffsetMs: offsetMs };
                if (Array.isArray(prev.local) && prev.local.length > 0) {
                    const selectableLyrics = getSelectableStructuredLyrics(prev.local);
                    const selectedLyric =
                        selectableLyrics[Math.min(indexToUse, selectableLyrics.length - 1)];
                    const idx = prev.local.findIndex((lyric) => lyric === selectedLyric);
                    if (idx === -1) return updated;

                    updated.local = [...prev.local];
                    updated.local[idx] = {
                        ...updated.local[idx],
                        offsetMs,
                    };
                }
                return updated;
            });
        },
        [currentSong, indexToUse, lyricsKey],
    );

    const setIndex = useCallback(
        (newIndex: number) => {
            setIndexState(newIndex);
            if (!lyricsKey || !data) return;
            const { selected: nextSelected, selectedSynced: nextSynced } =
                computeSelectedFromResult(data, preferLocalLyrics, newIndex);
            const nextOffset = getDisplayOffset(
                nextSelected,
                data.selectedOffsetMs,
                newIndex,
                data.local,
            );
            queryClient.setQueryData<LyricsQueryResult>(lyricsKey, (prev) =>
                prev
                    ? {
                          ...prev,
                          selected: nextSelected,
                          selectedOffsetMs: nextOffset,
                          selectedStructuredIndex: newIndex,
                          selectedSynced: nextSynced,
                      }
                    : prev,
            );
        },
        [data, lyricsKey, preferLocalLyrics],
    );

    const handleOnRemoveLyric = useCallback(async () => {
        if (!currentSong || !lyricsKey) return;

        queryClient.setQueryData<LyricsQueryResult>(lyricsKey, (prev) =>
            prev
                ? {
                      ...prev,
                      overrideData: null,
                      overrideSelection: null,
                      remoteAuto: null,
                      suppressRemoteAuto: true,
                  }
                : prev,
        );
        await queryClient.invalidateQueries({ queryKey: lyricsKey });
    }, [currentSong, lyricsKey]);

    const fetchTranslation = useCallback(async () => {
        if (!lyrics || isLyricsDisabled || !shouldUseExternalTranslation) return;
        const originalLyrics = Array.isArray(lyrics.lyrics)
            ? lyrics.lyrics.map(([, line]) => line).join('\n')
            : lyrics.lyrics;
        const TranslatedText: null | string = await translateLyrics(
            originalLyrics,
            translationApiKey,
            translationApiProvider,
            translationTargetLanguage,
        );
        setTranslatedLyrics(TranslatedText);
        setShowAnnotations(true);
    }, [
        isLyricsDisabled,
        lyrics,
        shouldUseExternalTranslation,
        translationApiKey,
        translationApiProvider,
        translationTargetLanguage,
    ]);

    const handleOnTranslateLyric = useCallback(async () => {
        if (!showAnnotations && canFetchExternalTranslation && !translatedLyrics) {
            await fetchTranslation();
            return;
        }

        if (hasServerAnnotations || translatedLyrics || !canFetchExternalTranslation) {
            setShowAnnotations(!showAnnotations);
            return;
        }
    }, [
        canFetchExternalTranslation,
        fetchTranslation,
        hasServerAnnotations,
        showAnnotations,
        translatedLyrics,
    ]);

    usePlayerEvents(
        {
            onCurrentSongChange: () => {
                setIndexState(0);
                setShowAnnotations(false);
                setTranslatedLyrics(null);
            },
        },
        [],
    );

    useEffect(() => {
        if (
            displayLyrics &&
            !translatedLyrics &&
            enableAutoTranslation &&
            shouldUseExternalTranslation
        ) {
            fetchTranslation();
        }
    }, [
        displayLyrics,
        translatedLyrics,
        enableAutoTranslation,
        fetchTranslation,
        shouldUseExternalTranslation,
    ]);

    const languages = useMemo(() => {
        const local = data?.local;
        if (Array.isArray(local)) {
            return local
                .filter(isMainStructuredLyric)
                .map((lyric, idx) => ({ label: lyric.lang, value: idx.toString() }));
        }
        if (local && !Array.isArray(local) && 'lyrics' in local) {
            return [{ label: 'xxx', value: '0' }];
        }
        return [];
    }, [data?.local]);

    const isLoadingLyrics = isLoading && !isLyricsDisabled;
    const hasNoLyrics = !displayLyrics;
    const [shouldFadeOut, setShouldFadeOut] = useState(false);

    useEffect(() => {
        if (!fadeOutNoLyricsMessage) {
            setShouldFadeOut(false);
            return undefined;
        }

        if (!isLoadingLyrics && hasNoLyrics) {
            const timer = setTimeout(() => {
                setShouldFadeOut(true);
            }, 3000);
            return () => clearTimeout(timer);
        }

        if (!hasNoLyrics) {
            setShouldFadeOut(false);
        }

        return undefined;
    }, [isLoadingLyrics, hasNoLyrics, fadeOutNoLyricsMessage]);

    const handleExportLyrics = useCallback(() => {
        if (lyrics && !isLyricsDisabled) {
            openLyricsExportModal({ lyrics, offsetMs: currentOffsetMs, synced });
        }
    }, [currentOffsetMs, isLyricsDisabled, lyrics, synced]);

    const handleOpenSettings = () => {
        openLyricsSettingsModal(settingsKey);
    };

    const canToggleAnnotations = hasServerAnnotations || canFetchExternalTranslation;

    return (
        <ComponentErrorBoundary>
            <div className={styles.lyricsContainer}>
                <ActionIcon
                    className={styles.settingsIcon}
                    icon="settings2"
                    iconProps={{ size: 'lg' }}
                    onClick={handleOpenSettings}
                    pos="absolute"
                    right={0}
                    top={0}
                    variant="subtle"
                />
                {isLoadingLyrics ? (
                    <Spinner container />
                ) : (
                    <AnimatePresence mode="sync">
                        {hasNoLyrics ? (
                            <Center w="100%">
                                <motion.div
                                    animate={{ opacity: shouldFadeOut ? 0 : 1 }}
                                    initial={{ opacity: 1 }}
                                    transition={{ duration: 0.5 }}
                                >
                                    <Group>
                                        <Text fw={500} isMuted isNoSelect>
                                            {t('page.fullscreenPlayer.noLyrics')}
                                        </Text>
                                    </Group>
                                </motion.div>
                            </Center>
                        ) : (
                            <motion.div
                                animate={{ opacity: 1 }}
                                className={styles.scrollContainer}
                                initial={{ opacity: 0 }}
                                transition={{ duration: 0.5 }}
                            >
                                {hasEnhancedCueLine(displayLyrics) ? (
                                    <EnhancedSynchronizedLyrics
                                        {...(displayLyrics as EnhancedSynchronizedLyricsProps)}
                                        offsetMs={displayOffsetMs}
                                        pronunciationLyrics={serverPronunciationLyrics}
                                        settingsKey={settingsKey}
                                        showAnnotations={showAnnotations}
                                        translatedLyrics={
                                            showAnnotations && shouldUseExternalTranslation
                                                ? translatedLyrics
                                                : null
                                        }
                                        translationLyrics={serverTranslationLyrics}
                                    />
                                ) : synced ? (
                                    <SynchronizedLyrics
                                        {...(displayLyrics as SynchronizedLyricsProps)}
                                        offsetMs={displayOffsetMs}
                                        romajiLyrics={
                                            enableRomaji
                                                ? (romajiConvertedLyrics as SynchronizedLyricsProps['romajiLyrics'])
                                                : null
                                        }
                                        pronunciationLyrics={serverPronunciationLyrics}
                                        settingsKey={settingsKey}
                                        showAnnotations={showAnnotations}
                                        translatedLyrics={showAnnotations ? translatedLyrics : null}
                                        translationLyrics={serverTranslationLyrics}
                                    />
                                ) : (
                                    <UnsynchronizedLyrics
                                        {...(displayLyrics as UnsynchronizedLyricsProps)}
                                        romajiLyrics={
                                            enableRomaji
                                                ? (romajiConvertedLyrics as UnsynchronizedLyricsProps['romajiLyrics'])
                                                : null
                                        }
                                        settingsKey={settingsKey}
                                        translatedLyrics={showAnnotations ? translatedLyrics : null}
                                    />
                                )}
                            </motion.div>
                        )}
                    </AnimatePresence>
                )}
                <div className={styles.actionsContainer}>
                    <LyricsActions
                        hasLyrics={!!displayLyrics}
                        index={indexToUse}
                        languages={languages}
                        offsetMs={displayOffsetMs}
                        onExportLyrics={handleExportLyrics}
                        onRemoveLyric={handleOnRemoveLyric}
                        onSearchOverride={handleOnSearchOverride}
                        onTranslateLyric={canToggleAnnotations ? handleOnTranslateLyric : undefined}
                        onUpdateOffset={handleUpdateOffset}
                        setIndex={setIndex}
                        settingsKey={settingsKey}
                        showAnnotations={showAnnotations}
                    />
                </div>
            </div>
        </ComponentErrorBoundary>
    );
};
