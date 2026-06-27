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

function getLyricParts(text: string, annotations?: (null | string | undefined)[]) {
    const legacyLines = text.split(/_BREAK_|__BREAK__/g);
    const mainText = annotations ? text : (legacyLines.at(-1) ?? text);
    const rawAnnotations = annotations ?? legacyLines.slice(0, -1);

    return {
        annotations: rawAnnotations.filter(
            (line): line is string =>
                typeof line === 'string' &&
                line.length > 0 &&
                normalizeLyricText(line) !== normalizeLyricText(mainText),
        ),
        text: mainText,
    };
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
                    {romajiText && (
                        <span
                            className={styles.annotation}
                            dangerouslySetInnerHTML={{ __html: sanitize(romajiText) }}
                        />
                    )}
                    {translatedText && (
                        <span dangerouslySetInnerHTML={{ __html: sanitize(translatedText) }} />
                    )}
                </Stack>
            </Box>
        );
    },
);

LyricLine.displayName = 'LyricLine';
