import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import { BaseToken } from "../../typechain"
import { PriceFeedDispatcher } from "../../typechain/perp-oracle"
import { CACHED_TWAP_INTERVAL } from "../shared/constant"
import { forwardRealTimestamp, getRealTimestamp, setRealTimestamp } from "../shared/time"
import { baseTokenFixture } from "./fixtures"

describe("BaseToken", async () => {
    const [admin, user] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let baseToken: BaseToken
    let priceFeedDispatcher: PriceFeedDispatcher
    let mockedAggregator: MockContract // used by ChainlinkPriceFeedV3
    let currentTime: number
    let chainlinkRoundData: any[]
    const closedPrice = parseEther("200")

    async function updateChainlinkPrice(): Promise<void> {
        mockedAggregator.smocked.latestRoundData.will.return.with(async () => {
            return chainlinkRoundData[chainlinkRoundData.length - 1]
        })
        await priceFeedDispatcher.dispatchPrice(CACHED_TWAP_INTERVAL)
    }

    beforeEach(async () => {
        const _fixture = await loadFixture(baseTokenFixture)
        baseToken = _fixture.baseToken
        mockedAggregator = _fixture.mockedAggregator
        priceFeedDispatcher = _fixture.priceFeedDispatcher

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

        // start with roundId != 0 as now if roundId == 0 Chainlink will be freezed
        chainlinkRoundData.push([1, parseUnits("400", 6), currentTime, currentTime, 1])
        await updateChainlinkPrice()

        currentTime += 15
        await setRealTimestamp(currentTime)
        chainlinkRoundData.push([2, parseUnits("405", 6), currentTime, currentTime, 2])
        await updateChainlinkPrice()

        currentTime += 15
        await setRealTimestamp(currentTime)
        chainlinkRoundData.push([3, parseUnits("410", 6), currentTime, currentTime, 3])
        await updateChainlinkPrice()

        currentTime += 15
        await setRealTimestamp(currentTime)
    })

    describe("twap", () => {
        it("twap price", async () => {
            const price = await baseToken.getIndexPrice(45)
            expect(price).to.eq(parseEther("405"))
        })

        it("asking interval more than aggregator has, should return latest price", async () => {
            const price = await baseToken.getIndexPrice(46)
            expect(price).to.eq(parseEther("410"))
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
            await expect(baseToken.connect(user).setPriceFeed(priceFeedDispatcher.address)).to.be.revertedWith("SO_CNO")
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
            let pausedTimestamp: number
            beforeEach(async () => {
                // currentTime: 45
                // To get twap 900, delta = 900 - 45 -1
                const forward = 900 - 45 - 1
                // _TWAP_INTERVAL_FOR_PAUSE: 900 secs
                await forwardRealTimestamp(forward)
                // paused index price (400*15+405*15+410*870) / 900 = 409.75
                await baseToken.pause()
                pausedTimestamp = currentTime + forward + 1
            })
            it("should return pausedIndexPrice as index price in paused status", async () => {
                expect(await baseToken.isPaused()).to.be.eq(true)

                let indexPrice = await baseToken.getIndexPrice(0)
                expect(indexPrice).to.be.eq(parseEther("409.75"))

                indexPrice = await baseToken.getIndexPrice(100)
                expect(indexPrice).to.be.eq(parseEther("409.75"))

                expect(await baseToken.getPausedIndexPrice()).to.be.eq(parseEther("409.75"))
            })

            it("should return the paused timestamp", async () => {
                expect(await baseToken.isPaused()).to.be.eq(true)
                expect(await baseToken.getPausedTimestamp()).to.eq(pausedTimestamp)
            })
        })

        describe("closed status", async () => {
            let pausedTimestamp: number
            beforeEach(async () => {
                // currentTime: 45
                // To get twap 900, delta = 900 - 45 -1
                const forward = 900 - 45 - 1
                // _TWAP_INTERVAL_FOR_PAUSE: 900 secs
                await forwardRealTimestamp(forward)
                // paused index price (400*15+405*15+410*870) / 900 = 409.75
                await baseToken.pause()
                pausedTimestamp = currentTime + forward + 1
            })

            it("verify status after market paused", async () => {
                const indexPrice = await baseToken.getIndexPrice(CACHED_TWAP_INTERVAL)
                expect(indexPrice).to.be.eq(parseEther("409.75"))

                expect(await baseToken.getPausedIndexPrice()).to.be.eq(parseEther("409.75"))
                expect(await baseToken.getPausedTimestamp()).to.eq(pausedTimestamp)

                expect(await baseToken.isPaused()).to.be.eq(true)
            })

            it("close by owner, should return closedPrice", async () => {
                await baseToken["close(uint256)"](closedPrice)

                expect(await baseToken.isClosed()).to.be.eq(true)

                let indexPrice = await baseToken.getIndexPrice(CACHED_TWAP_INTERVAL)
                let pausedIndexPrice = await baseToken.getPausedIndexPrice()
                expect(indexPrice).to.be.eq(pausedIndexPrice)

                indexPrice = await baseToken.getIndexPrice(100)
                expect(indexPrice).to.be.eq(pausedIndexPrice)

                // need to check paused status because we will calculate funding form paused time
                expect(await baseToken.getPausedTimestamp()).to.eq(pausedTimestamp)
                expect(pausedIndexPrice).to.be.eq(parseEther("409.75"))
                expect(await baseToken.getClosedPrice()).to.be.eq(closedPrice)
            })

            it("close by user", async () => {
                await forwardRealTimestamp(86400 * 7)

                await baseToken.connect(user)["close()"]()

                expect(await baseToken.isClosed()).to.be.eq(true)

                let indexPrice = await baseToken.getIndexPrice(0)
                expect(indexPrice).to.be.eq(parseEther("409.75"))

                indexPrice = await baseToken.getIndexPrice(100)
                expect(indexPrice).to.be.eq(parseEther("409.75"))

                // need to check paused status because we will calculate funding form paused time
                expect(await baseToken.getPausedTimestamp()).to.eq(pausedTimestamp)
                expect(await baseToken.getPausedIndexPrice()).to.be.eq(parseEther("409.75"))
            })
        })
    })
})
