/**
 * @author Edward Carl
 * This could definitely be made more object-oriented, but from my perspective it would add a bunch of boilerplate code for no 
 * practical extensibility gains.
 * 
 * The obvious objects would be for creation of:
 *    A) frequency-to-position mappings, but the only two perceptually useful ones (gamma and logarithmic) fit within single, short functions.
 *    B) position-to-bin mappings, but those, again, can be easily fit in brief functions.
 * 
 * I could separate this into a 'client' and 'server', but the only reason to do so would be if I wanted slightly better performance for
 * multiple simultaneous visualizations, which isn't an intended use case.
 */
const { RtAudio, RtAudioFormat, RtAudioStreamFlags } = require('audify');
const ft = require('fourier-transform');
const wndw = require('fft-windowing');
const rtAudio = new RtAudio();
const config = require('getconfig');

const canvas = document.getElementById('visual');
const canvasContext = canvas.getContext('2d');

const maximumFrequency = config.sampleRate / 2;
const [sliceLength, sliceStart, sliceEnd] = sliceFrequencyIndices(config.fftSize, config.minPlottedFreq, config.maxPlottedFreq);
const fillerArray = getFftFillerArray();
const coords = gammaCoordinates(config.stretchFactor);
const [binMap, edgeMap] = minSizeBinning(coords, config.minBinWidth);

let rawData, magnitudes, oldMagnitudes;


rtAudio.openStream(
  null,
  {
    deviceID: rtAudio.getDefaultInputDevice(),
    nChannels: 1, // currently only takes in the left channel
    firstChannel: 0
  },
  RtAudioFormat.RTAUDIO_SINT16, // device audio format - signed 16-bit, LE
  config.sampleRate, //audio sample rate
  config.frameSize, //number of samples fed to FFT
  "yammmm-overlay", // stream name for pulse audio
  (pcm) => {
      rawData = pcm;
  },
  null,
  (RtAudioStreamFlags.RTAUDIO_SCHEDULE_REALTIME + RtAudioStreamFlags.RTAUDIO_MINIMIZE_LATENCY)
);

/**
 * @return an all-zeroed array of an appropriate size to have power-of-two length
 * when appended to a collection of samples from the audio stream.
 *  
 */
function getFftFillerArray(){
  let count = 2;
  while (count < config.frameSize){
    count *= 2;
  }
  return new Uint8Array((count - config.frameSize) * 2).fill(0); //doubled for Uint8-Uint16 conversion later
}

/**
 * Given the length of the array of FFT results and the frequency range we wish to plot, 
 * returns the properties of the view containing only the relevant data.
 * @param {*} arrayLength size of the FFT array
 * @param {*} startFrequency lowest represented frequency, in Hz
 * @param {*} endFrequency  highest represented frequency, in Hz
 */
function sliceFrequencyIndices(arrayLength, startFrequency, endFrequency){
  let sliceStart = Math.floor((arrayLength - 1) * startFrequency / maximumFrequency);
  let sliceEnd = Math.floor((arrayLength - 1) * endFrequency / maximumFrequency);
  let sliceLength = 1 + sliceEnd - sliceStart;
  return [sliceLength, sliceStart, sliceEnd];
}

/**
 * Maps FFT bins onto horizontal coordinates based on frequencies' proportional values raised to the power (1 / gamma).
 * This is a very rough approximation of a log function, which gives aesthetically pleasing results for values between 1.1 and ~1.6.
 * @param {*} gamma A constant reflecting the degree to which the frequency mapping is "stretched".
 *     Note that the degree of stretching does NOT scale linearly with gamma; the spacing follows a power function.
 * 
 * @return frequencyCoordinates, an array containing the scaled horizontal position, in pixels, of each frequency in the interval.
 */
function gammaCoordinates(gamma = 1.2){
  let frequencyCoordinates = new Array(sliceLength);
  
  for (let i = 0; i < sliceLength; i++){
    frequencyCoordinates[i] = (canvas.width * (i / sliceLength) ** (1 / gamma));
  }
  return frequencyCoordinates;
}

/**
 * Maps FFT binds onto horizontal axis based on the logarithm of frequencies' proportional values.
 * Included because human perception reflects a logarithmic frequency scale; each octave is 2x the previous.
 * In practice, the linear spacing of FFT bins leads to an unusably sparse low-frequency range.
 * Use gammaCoordinates() for an aesthetically pleasing, if distorted, alternative.
 */
function logarithmicCoordinates(){
  let frequencyCoordinates = new Array(sliceLength);
  //we want to find base B, such that log_B(sliceLength) = canvas.width
  //B^canvas.width = sliceLength
  //B = exp(ln(sliceLength) / canvas.width)
  let baseB = Math.exp(Math.log(sliceLength - 1) / canvas.width);
  //console.log(baseB)
  for (let i = 0; i < sliceLength; i++){
    frequencyCoordinates[i] = Math.log(i) / Math.log(baseB);
  }
  return frequencyCoordinates;
}

/**
 * 
 * @param {*} frequencyCoordinates An array containing the scaled horizontal position of the frequency at each index, 
 *                                 as output by a ___Coordinates() function
 * @param {*} minWidth The minumum width, in pixels, of each bin
 * 
 * @return {Array} frequencyBinMap, an array containing the number of the bin each frequency will ultimately be plotted under
 * @return {Array} binEdgeMap, an array containing the horizontal coordinate of the leading edge of each bin 
 */
function minSizeBinning(frequencyCoordinates, minWidth = 5){
  
  let frequencyBinMap = new Array(frequencyCoordinates.length).fill(-1); //an entry of -1 indicates that a frequency will not be graphed

  let binEdgeMap = new Array(1).fill(0);
    for (let frequencyId = sliceStart; frequencyId < sliceEnd + 1; frequencyId++){
      let nextFreqEdge = Math.round(frequencyCoordinates[frequencyId - sliceStart]);
      let binWidth = nextFreqEdge - binEdgeMap[binEdgeMap.length - 1]; //distance between leading edge of current bin and leading edge of last bin
      frequencyBinMap[frequencyId] = binEdgeMap.length; //mark this frequency as being for the current bin
      if (binWidth >= minWidth){
        binEdgeMap.push(nextFreqEdge);
      } //otherwise, we just "extend" this bin to include the next frequency (done in the next iteration)
    }
      return [frequencyBinMap, binEdgeMap]
}

/**
 * 
 * @param {*} frequencyData An array of the magnitudes of each frequency as calculated by fast fourier transform
 * @param {*} frequencyBinMap frequencyBinMap, an array containing the number of the bin each frequency will ultimately 
 *                            be plotted under, as output by a  ___Binning()
 * @return {Array} binHeights, an array of the maximum magnitude of the members of each bin. 
 *                 This determines the heights of the final drawn bars.
 */
function calculateBinHeights(frequencyData, frequencyBinMap){
  let binHeights = new Array(frequencyBinMap[frequencyBinMap.length - 1] + 1).fill(0);
  for (let i = 0; i < frequencyData.length; i++){ //ignore frequencies outside the range
    if (frequencyBinMap[i] == -1){
      continue;
    }
    if (frequencyData[i] > binHeights[frequencyBinMap[i]]){
      binHeights[frequencyBinMap[i]] = frequencyData[i];
    }
  }
  return binHeights
}

function smoothing(magnitudes, oldMagnitudes, smoothRatio) {
  for (let i = 0; i < magnitudes.length; i++) {
    magnitudes[i] = (oldMagnitudes[i] * smoothRatio) + (magnitudes[i] * (1 - smoothRatio));
  }
}




function draw() {
  requestAnimationFrame(draw);

  if (rawData !== undefined) {
    let real = Buffer.concat([rawData, fillerArray]); //total length 4096 bytes, but it's 16-bit audio so this represents 2048 samples
    real = new Uint16Array(real.buffer, real.byteOffset, real.byteLength / Uint16Array.BYTES_PER_ELEMENT) //total length 2048

    oldMagnitudes = magnitudes
    magnitudes = ft(wndw.blackman(real, 0.16)); //total length 1024

    if (oldMagnitudes !== undefined) { //oldMagnitudes is undefined for the very first draw cycle
      smoothing(magnitudes, oldMagnitudes, config.smoothingConstant)
    }
    let binHeights = calculateBinHeights(magnitudes, binMap);

    canvasContext.fillStyle = 'rgb(0,0,0)';
    canvasContext.fillRect(0, 0, canvas.width, canvas.height);
    
    let oldEdge;
    let edge = 0;
    for (let i = 0; i < edgeMap.length; i++){
      oldEdge = edge;
      edge = edgeMap[i];
      let barHeight = (Math.log(binHeights[i]) - config.dampingFactor) * config.scalingFactor;
      let barWidth = edge - oldEdge - 1;
      canvasContext.fillStyle = 'rgb(100,100,100)';
      canvasContext.fillRect(oldEdge + i, canvas.height - barHeight, barWidth, barHeight);
    }
  }
}



rtAudio.start();
draw();
