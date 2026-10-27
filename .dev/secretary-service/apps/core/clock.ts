export class Clock {
  private sample?:{wall:number;mono:number};
  private trusted:boolean;
  private reason:string|null;
  constructor(private wall=()=>new Date(),private monotonic=()=>performance.now(),
    synchronized=true,private detectJumps=true) {
    this.trusted=synchronized;this.reason=synchronized?null:"TIME_SYNC_UNVERIFIED";
  }
  read() {
    const wall=this.wall(),mono=this.monotonic();
    if(!Number.isFinite(wall.getTime()) || this.detectJumps && this.sample &&
      Math.abs(wall.getTime()-this.sample.wall-(mono-this.sample.mono))>5000) {
      this.trusted=false;this.reason="CLOCK_DISCONTINUITY";
    }
    this.sample={wall:wall.getTime(),mono};
    return {wallNow:wall,monoNow:mono,trusted:this.trusted,reason:this.reason};
  }
  verifySynchronized(verified:boolean) {
    this.trusted=verified;this.reason=verified?null:"TIME_SYNC_UNVERIFIED";this.sample=undefined;
  }
}
