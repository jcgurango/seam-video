import React, { DetailedHTMLProps, useEffect, useRef, useState } from "react";

interface VideoProps {
  isPlaying: boolean;
  time: number;
  rate?: number;
}

const DRIFT_TOLERANCE = 0.1;

export default function Video({ isPlaying, time, rate = 1, ...props }: DetailedHTMLProps<React.VideoHTMLAttributes<HTMLVideoElement>, HTMLVideoElement> & VideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [elementIsPlaying, setElementIsPlaying] = useState(false);

  useEffect(() => {
    const video = videoRef.current;

    if (!video) return;

    if (isPlaying && !elementIsPlaying) {
      video.play().then(() => setElementIsPlaying(true)).catch(console.error);
    }

    if (!isPlaying && elementIsPlaying) {
      video.pause();
    }
  }, [isPlaying, elementIsPlaying, videoRef]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video) return;

    if (Math.abs(video.currentTime - time) > DRIFT_TOLERANCE * Math.max(rate, 1)) {
      console.log("DRIFT");
      video.currentTime = time;
    }
  }, [time, rate, videoRef]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video) return;

    if (video.playbackRate !== rate) {
      video.playbackRate = rate;
    }
  }, [rate, videoRef]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video) return;

    const playingCallback = () => setElementIsPlaying(true);
    const pauseCallback = () => setElementIsPlaying(false);
    
    video.addEventListener("playing", playingCallback);
    video.addEventListener("pause", pauseCallback);

    return () => {
      video.removeEventListener("playing", playingCallback);
      video.removeEventListener("pause", pauseCallback);
    };
  }, [videoRef]);

  return (
    <video
      ref={videoRef}
      {...props}
      autoPlay={false}
    />
  );
}