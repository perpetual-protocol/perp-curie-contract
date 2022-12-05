import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import { BaseToken } from "../../typechain"
import { BandPriceFeed, PriceFeedDispatcher } from "../../typechain/perp-oracle"
import { forwardRealTimestamp, getRealTimestamp, setRealTimestamp } from "../shared/time"
import { baseTokenFixture } from "./fixtures"

describe.only("BaseToken", async () => {
    const [admin, user] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let baseToken: BaseToken
    let priceFeedDispatcher: PriceFeedDispatcher
    let mockedAggregator: MockContract // used by ChainlinkPriceFeedV2
    let bandPriceFeed: BandPriceFeed
    let mockedStdReference: MockContract // used by BandPriceFeed
    let currentTime: number
    let chainlinkRoundData: any[]
    let bandReferenceData: any[]
    const closedPrice = parseEther("200")

    async function updateBandPrice(): Promise<void> {
        mockedStdReference.smocked.getReferenceData.will.return.with(async () => {
            return bandReferenceData[bandReferenceData.length - 1]
        })
        await bandPriceFeed.update()
    }

    async function updateChainlinkPrice(): Promise<void> {
        mockedAggregator.smocked.latestRoundData.will.return.with(async () => {
            return chainlinkRoundData[chainlinkRoundData.length - 1]
        })
        await priceFeedDispatcher.dispatchPrice(15 * 60)
    }

    beforeEach(async () => {
        const _fixture = await loadFixture(baseTokenFixture)
        baseToken = _fixture.baseToken
        mockedAggregator = _fixture.mockedAggregator
        bandPriceFeed = _fixture.bandPriceFeed
        priceFeedDispatcher = _fixture.priceFeedDispatcher
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
        currentTime = await getRealTimestamp()

        chainlinkRoundData = [
            // [roundId, answer, startedAt, updatedAt, answeredInRound]
        ]
        bandReferenceData = [
            // [rate, lastUpdatedBase, lastUpdatedQuote]
        ]

        // start with roundId != 0 as now if roundId == 0 Chainlink will be freezed
        chainlinkRoundData.push([1, parseUnits("400", 6), currentTime, currentTime, 1])
        bandReferenceData.push([parseUnits("400", 18), currentTime, currentTime])
        await updateBandPrice()
        await updateChainlinkPrice()

        currentTime += 15
        await setRealTimestamp(currentTime)
        chainlinkRoundData.push([2, parseUnits("405", 6), currentTime, currentTime, 2])
        bandReferenceData.push([parseUnits("405", 18), currentTime, currentTime])
        await updateBandPrice()
        await updateChainlinkPrice()

        currentTime += 15
        await setRealTimestamp(currentTime)
        chainlinkRoundData.push([3, parseUnits("410", 6), currentTime, currentTime, 3])
        bandReferenceData.push([parseUnits("410", 18), currentTime, currentTime])
        await updateBandPrice()
        await updateChainlinkPrice()

        currentTime += 15
        await setRealTimestamp(currentTime)
    })

    describe("twap", () => {
        it("twap price", async () => {
            const price = await baseToken.getIndexPrice(45)
            console.log(price.toString())
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
            await forwardRealTimestamp(50)

            // twap price should be ((400 * 15) + (405 * 15) + (410 * 45) + (420 * 20)) / 95 = 409.736
            const price = await baseToken.getIndexPrice(95)
            expect(price).to.eq("409736842000000000000")
        })

        it("latest price update time is earlier than the request, return the latest price", async () => {
            await forwardRealTimestamp(100)

            // latest update time is base + 30, but now is base + 145 and asking for (now - 45)
            // should return the latest price directly
            const price = await baseToken.getIndexPrice(45)
            expect(price).to.eq(parseEther("410"))
        })

        // WARNING: this test can fail for unknown reason for the function baseToken.getIndexPrice(), while it won't in other cases
        it("if current price < 0, ignore the current price", async () => {
            chainlinkRoundData.push([4, parseUnits("-10", 6), 250, 250, 4])
            const price = await baseToken.getIndexPrice(45)
            expect(price).to.eq(parseEther("405"))
        })

        it("if there is a negative price in the middle, ignore that price", async () => {
            chainlinkRoundData.push([4, parseUnits("-100", 6), currentTime + 20, currentTime + 20, 4])
            chainlinkRoundData.push([5, parseUnits("420", 6), currentTime + 30, currentTime + 30, 5])
            await forwardRealTimestamp(50)

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
            await setRealTimestamp(currentTime)

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

    describe("BaseToken status", async () => {
        it("forced error when close by owner without paused", async () => {
            await expect(baseToken["close(uint256)"](closedPrice)).to.be.revertedWith("BT_NP")
            await expect(baseToken.connect(user)["close()"]()).to.be.revertedWith("BT_NP")
        })

        it("forced error when close by user before waiting period expired", async () => {
            await baseToken.pause()
            await expect(baseToken.connect(user)["close()"]()).to.be.revertedWith("BT_WPNE")
        })

        it("forced error when pause without opened", async () => {
            await baseToken.pause()
            await expect(baseToken.pause()).to.be.revertedWith("BT_NO")
            await baseToken["close(uint256)"](closedPrice)
            await expect(baseToken.pause()).to.be.revertedWith("BT_NO")
        })

        describe("opened status", async () => {
            it("initial status should be opened", async () => {
                expect(await baseToken.isOpen()).to.be.eq(true)
            })
        })

        describe("paused status", async () => {
            it("should return pausedIndexPrice as index price in paused status", async () => {
                // paused index price (410*16+405*15+400*15)/46 = 405.108695
                await baseToken.pause()

                expect(await baseToken.isPaused()).to.be.eq(true)

                let indexPrice = await baseToken.getIndexPrice(0)
                expect(indexPrice).to.be.eq(parseEther("405.108695"))

                indexPrice = await baseToken.getIndexPrice(100)
                expect(indexPrice).to.be.eq(parseEther("405.108695"))

                expect(await baseToken.getPausedIndexPrice()).to.be.eq(parseEther("405.108695"))
            })

            it("should return the paused timestamp", async () => {
                await baseToken.pause()

                expect(await baseToken.isPaused()).to.be.eq(true)
                expect(await baseToken.getPausedTimestamp()).to.eq(currentTime + 1)
            })
        })

        describe("closed status", async () => {
            beforeEach(async () => {
                // paused index price (410*16+405*15+400*15)/46 = 405.108695
                await baseToken.pause()
            })

            it("verify status after market paused", async () => {
                const indexPrice = await baseToken.getIndexPrice(15 * 60)
                expect(indexPrice).to.be.eq(parseEther("405.108695"))

                expect(await baseToken.getPausedIndexPrice()).to.be.eq(parseEther("405.108695"))
                expect(await baseToken.getPausedTimestamp()).to.eq(currentTime + 1)

                expect(await baseToken.isPaused()).to.be.eq(true)
            })

            it("close by owner, should return closedPrice", async () => {
                await baseToken["close(uint256)"](closedPrice)

                expect(await baseToken.isClosed()).to.be.eq(true)

                let indexPrice = await baseToken.getIndexPrice(15 * 60)
                let pausedIndexPrice = await baseToken.getPausedIndexPrice()
                expect(indexPrice).to.be.eq(pausedIndexPrice)

                indexPrice = await baseToken.getIndexPrice(100)
                expect(indexPrice).to.be.eq(pausedIndexPrice)

                // need to check paused status because we will calculate funding form paused time
                expect(await baseToken.getPausedTimestamp()).to.eq(currentTime + 1)
                expect(pausedIndexPrice).to.be.eq(parseEther("405.108695"))
                expect(await baseToken.getClosedPrice()).to.be.eq(parseEther("200"))
            })

            it("close by user", async () => {
                await forwardRealTimestamp(86400 * 7)

                await baseToken.connect(user)["close()"]()

                expect(await baseToken.isClosed()).to.be.eq(true)

                let indexPrice = await baseToken.getIndexPrice(0)
                expect(indexPrice).to.be.eq(parseEther("405.108695"))

                indexPrice = await baseToken.getIndexPrice(100)
                expect(indexPrice).to.be.eq(parseEther("405.108695"))

                // need to check paused status because we will calculate funding form paused time
                expect(await baseToken.getPausedTimestamp()).to.eq(currentTime + 1)
                expect(await baseToken.getPausedIndexPrice()).to.be.eq(parseEther("405.108695"))
            })
        })
    })
})
