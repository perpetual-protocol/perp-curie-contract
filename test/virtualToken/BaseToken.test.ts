import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { BaseToken } from "../../typechain"
import { BandPriceFeed, ChainlinkPriceFeed } from "../../typechain/perp-oracle"
import { setNextBlockTimestamp } from "../shared/time"
import { baseTokenFixture } from "./fixtures"

describe("BaseToken", async () => {
    const [admin, user] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let baseToken: BaseToken
    let chainlinkPriceFeed: ChainlinkPriceFeed
    let mockedAggregator: MockContract // used by ChainlinkPriceFeed
    let bandPriceFeed: BandPriceFeed
    let mockedStdReference: MockContract // used by BandPriceFeed
    let currentTime: number
    let chainlinkRoundData: any[]
    let bandReferenceData: any[]

    async function updateBandPrice(): Promise<void> {
        mockedStdReference.smocked.getReferenceData.will.return.with(async () => {
            return bandReferenceData[bandReferenceData.length - 1]
        })
        await bandPriceFeed.update()
    }

    beforeEach(async () => {
        const _fixture = await loadFixture(baseTokenFixture)
        baseToken = _fixture.baseToken
        mockedAggregator = _fixture.mockedAggregator
        bandPriceFeed = _fixture.bandPriceFeed
        mockedStdReference = _fixture.mockedStdReference

        // `base` = now - _interval
        // aggregator's answer
        // timestamp(base + 0)  : 400
        // timestamp(base + 15) : 405
        // timestamp(base + 30) : 410
        // now = base + 45
        //
        //  --+------+-----+-----+-----+-----+-----+
        //          base                          now
        const latestTimestamp = (await waffle.provider.getBlock("latest")).timestamp
        currentTime = latestTimestamp

        chainlinkRoundData = [
            // [roundId, answer, startedAt, updatedAt, answeredInRound]
        ]
        bandReferenceData = [
            // [rate, lastUpdatedBase, lastUpdatedQuote]
        ]

        currentTime += 0
        chainlinkRoundData.push([0, parseUnits("400", 6), currentTime, currentTime, 0])
        bandReferenceData.push([parseUnits("400", 18), currentTime, currentTime])
        await updateBandPrice()

        currentTime += 15
        await setNextBlockTimestamp(currentTime)
        chainlinkRoundData.push([1, parseUnits("405", 6), currentTime, currentTime, 1])
        bandReferenceData.push([parseUnits("405", 18), currentTime, currentTime])
        await updateBandPrice()

        currentTime += 15
        await setNextBlockTimestamp(currentTime)
        chainlinkRoundData.push([2, parseUnits("410", 6), currentTime, currentTime, 2])
        bandReferenceData.push([parseUnits("410", 18), currentTime, currentTime])
        await updateBandPrice()

        mockedAggregator.smocked.latestRoundData.will.return.with(async () => {
            return chainlinkRoundData[chainlinkRoundData.length - 1]
        })

        mockedAggregator.smocked.getRoundData.will.return.with((round: BigNumber) => {
            return chainlinkRoundData[round.toNumber()]
        })

        currentTime += 15
        await setNextBlockTimestamp(currentTime)
    })

    describe("twap", () => {
        it("twap price", async () => {
            const price = await baseToken.getIndexPrice(45)
            expect(price).to.eq(parseEther("405"))
        })

        it("asking interval more than aggregator has", async () => {
            const price = await baseToken.getIndexPrice(46)
            expect(price).to.eq(parseEther("405"))
        })

        it("asking interval less than aggregator has", async () => {
            const price = await baseToken.getIndexPrice(44)
            expect(price).to.eq("405113636000000000000")
        })

        it("given variant price period", async () => {
            chainlinkRoundData.push([4, parseUnits("420", 6), currentTime + 30, currentTime + 30, 4])
            await ethers.provider.send("evm_setNextBlockTimestamp", [currentTime + 50])
            await ethers.provider.send("evm_mine", [])

            // twap price should be ((400 * 15) + (405 * 15) + (410 * 45) + (420 * 20)) / 95 = 409.736
            const price = await baseToken.getIndexPrice(95)
            expect(price).to.eq("409736842000000000000")
        })

        it("latest price update time is earlier than the request, return the latest price", async () => {
            await ethers.provider.send("evm_setNextBlockTimestamp", [currentTime + 100])
            await ethers.provider.send("evm_mine", [])

            // latest update time is base + 30, but now is base + 145 and asking for (now - 45)
            // should return the latest price directly
            const price = await baseToken.getIndexPrice(45)
            expect(price).to.eq(parseEther("410"))
        })

        it("if current price < 0, ignore the current price", async () => {
            chainlinkRoundData.push([3, parseUnits("-10", 6), 250, 250, 3])
            const price = await baseToken.getIndexPrice(45)
            expect(price).to.eq(parseEther("405"))
        })

        it("if there is a negative price in the middle, ignore that price", async () => {
            chainlinkRoundData.push([3, parseUnits("-100", 6), currentTime + 20, currentTime + 20, 3])
            chainlinkRoundData.push([4, parseUnits("420", 6), currentTime + 30, currentTime + 30, 4])
            await ethers.provider.send("evm_setNextBlockTimestamp", [currentTime + 50])
            await ethers.provider.send("evm_mine", [])

            // twap price should be ((400 * 15) + (405 * 15) + (410 * 45) + (420 * 20)) / 95 = 409.736
            const price = await baseToken.getIndexPrice(95)
            expect(price).to.eq("409736842000000000000")
        })

        it("return latest price if interval is zero", async () => {
            const price = await baseToken.getIndexPrice(0)
            expect(price).to.eq(parseEther("410"))
        })
    })

    describe("BaseToken changes PriceFeed", async () => {
        it("forced error when non-owner calls setPriceFeed", async () => {
            await expect(baseToken.connect(user).setPriceFeed(bandPriceFeed.address)).to.be.revertedWith("SO_CNO")
        })

        it("change from ChainlinkPrice to BandPriceFeed", async () => {
            const spotPriceFromChainlink = await baseToken.getIndexPrice(0)
            expect(spotPriceFromChainlink).to.eq(parseEther("410"))

            const twapFromChainlink = await baseToken.getIndexPrice(45)
            expect(twapFromChainlink).to.eq(parseEther("405"))

            bandReferenceData.push([parseUnits("415", 18), currentTime, currentTime])
            await updateBandPrice()

            // hardhat will increase block timestamp by 1 for each transactions
            await expect(baseToken.setPriceFeed(bandPriceFeed.address))
                .to.emit(baseToken, "PriceFeedChanged")
                .withArgs(bandPriceFeed.address)

            expect(await baseToken.getPriceFeed()).to.eq(bandPriceFeed.address)

            const spotPriceFromBand = await baseToken.getIndexPrice(0)
            expect(spotPriceFromBand).to.eq(parseEther("415"))

            currentTime += 15
            await setNextBlockTimestamp(currentTime)

            // ob0 (ts, priceCumulative) = (t0,0)
            // ob1 (ts, priceCumulative) = (t0+15,6000)
            // ob2 (ts, priceCumulative) = (t0+30,12075)
            // ob3 (ts, priceCumulative) = (t0+45,18225)
            // latestBandData(ts, price): (t0+45, 415)
            // current timestamp = t0+60
            // currentPriceCumulative =
            //     lastestObservation.priceCumulative +
            //     (lastestObservation.price * (latestBandData.lastUpdatedBase - lastestObservation.timestamp)) +
            //     (latestBandData.rate * (currentTimestamp - latestBandData.lastUpdatedBase));
            // = 18225 + 415 * (t0+45 - (t0+45)) + 415 * (t0+60 - (t0+45))
            // = 24450
            // target ts: current ts - interval = t0+60-45 = t0+15
            // targetPriceCumulative = ob1's PriceCumulative = 6000
            // twap = (currentPriceCumulative-targetPriceCumulative) / interval
            //      = (24450-6000) / 45 = 410
            const twapFromBand = await baseToken.getIndexPrice(45)
            expect(twapFromBand).to.eq(parseEther("410"))
        })
    })
})
