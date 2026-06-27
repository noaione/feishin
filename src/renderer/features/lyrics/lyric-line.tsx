import clsx from 'clsx';
import { ComponentPropsWithoutRef, memo, useMemo } from 'react';

import styles from './lyric-line.module.css';

import { sanitize } from '/@/renderer/utils/sanitize';
import { Box } from '/@/shared/components/box/box';
import { Stack } from '/@/shared/components/stack/stack';

interface LyricLineProps extends ComponentPropsWithoutRef<'div'> {
    alignment: 'center' | 'left' | 'right';
    annotations?: (null | string | undefined)[];
    fontSize: number;
    romajiText?: null | string;
    text: string;
    translatedText?: null | string;
}

function normalizeLyricText(text: string) {
    return text.replaceAll(/\s+/g, ' ').trim();
}

export const LyricLine = memo(
    ({
        alignment,
        className,
        fontSize,
        romajiText,
        text,
        translatedText,
        ...props
    }: LyricLineProps) => {
        const lines = useMemo(() => text.split('_BREAK_'), [text]);

        /* Show if diferent */
        const normalizedRomajiText = useMemo(() => {
            if (!romajiText) return null;
            const normRomaji = normalizeLyricText(romajiText);
            const normText = normalizeLyricText(text);
            if (normRomaji === normText) return null;
            return romajiText;
        }, [romajiText, text]);
        const normalizedTranslatedText = useMemo(() => {
            if (!translatedText) return null;
            const normTranslated = normalizeLyricText(translatedText);
            const normText = normalizeLyricText(text);
            if (normTranslated === normText) return null;
            return translatedText;
        }, [translatedText, text]);

        const style = useMemo(
            () => ({
                fontSize,
                textAlign: alignment,
            }),
            [fontSize, alignment],
        );

        return (
            <Box className={clsx(styles.lyricLine, className)} style={style} {...props}>
                <Stack gap={0}>
                    {lines.map((line, index) => (
                        <span dangerouslySetInnerHTML={{ __html: sanitize(line) }} key={index} />
                    ))}
                    {normalizedRomajiText && (
                        <span
                            className={styles.annotation}
                            dangerouslySetInnerHTML={{ __html: sanitize(normalizedRomajiText) }}
                        />
                    )}
                    {normalizedTranslatedText && (
                        <span
                            className={styles.annotation}
                            dangerouslySetInnerHTML={{ __html: sanitize(normalizedTranslatedText) }}
                        />
                    )}
                </Stack>
            </Box>
        );
    },
);

LyricLine.displayName = 'LyricLine';
