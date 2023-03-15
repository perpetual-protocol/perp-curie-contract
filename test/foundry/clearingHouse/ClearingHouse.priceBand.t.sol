pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "../helper/Setup.sol";
import "../../../contracts/interface/IClearingHouse.sol";
import { IPriceFeed } from "@perp/perp-oracle-contract/contracts/interface/IPriceFeed.sol";

contract ClearingHousePriceBandTest is Setup {
    address trader = makeAddr("Trader");
    address maker = makeAddr("Maker");

    uint8 usdcDecimals;

    function setUp() public virtual override {
        Setup.setUp();

        // set baseToken priceBand to 10%
        exchange.setPriceBand(address(baseToken), 0.1e6);

        // initial market
        pool.initialize(792281625142 ether);
        pool.increaseObservationCardinalityNext(250);
        marketRegistry.addPool(address(baseToken), pool.fee());
        marketRegistry.setFeeRatio(address(baseToken), 10000);
        marketRegistry.setInsuranceFundFeeRatio(address(baseToken), 100000);
        exchange.setMaxTickCrossedWithinBlock(address(baseToken), 250);

        // mock priceFeed oracle
        vm.mockCall(
            _BASE_TOKEN_PRICE_FEED,
            abi.encodeWithSelector(IPriceFeed.getPrice.selector),
            abi.encode(100 * 1e8)
        );
        usdcDecimals = usdc.decimals();

        // mint usdc to maker and deposit to vault
        uint256 makerUsdcAmount = 10000 * 10**usdcDecimals;
        usdc.mint(maker, makerUsdcAmount);
        vm.startPrank(maker);
        usdc.approve(address(vault), makerUsdcAmount);
        vault.deposit(address(usdc), makerUsdcAmount);
        vm.stopPrank();

        // mint 1000 usdc to trader and deposit to vault
        uint256 traderUsdcAmount = 1000 * 10**usdcDecimals;
        usdc.mint(trader, traderUsdcAmount);
        vm.startPrank(trader);
        usdc.approve(address(vault), traderUsdcAmount);
        vault.deposit(address(usdc), traderUsdcAmount);
        vm.stopPrank();

        // maker add liquidity
        vm.prank(maker);
        clearingHouse.addLiquidity(
            IClearingHouse.AddLiquidityParams({
                baseToken: address(baseToken),
                base: 200 ether,
                quote: 20000 ether,
                lowerTick: -887220,
                upperTick: 887220,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: block.timestamp
            })
        );

        // initiate timestamp to enable last tick update; should be larger than Exchange._PRICE_LIMIT_INTERVAL
        vm.warp(block.timestamp + 100);
    }

    // before in range, after in range
    function test_open_long_position_when_before_and_after_is_in_range() public {
        // open long position => market price > index price
        // before:
        //  - market price: 99.9999999998
        //  - spread: 0
        // after:
        //  - market price: 100.9924502498
        //  - spread: 9924 (0.9924 %)
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: false,
                isExactInput: true,
                amount: 100 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );
    }

    // before in range, after in range
    function test_open_short_position_when_before_and_after_is_in_range() public {
        // open long position => market price < index price
        // before:
        //  - market price: 99.9999999998
        //  - spread: 0
        // after:
        //  - market price: 98.9927965078
        //  - spread: 10072 (1.0072 %)
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: true,
                isExactInput: true,
                amount: 2 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );
    }

    // before in range, after out of range
    function test_open_long_position_when_before_in_range_but_after_our_of_range() public {
        // open long position => market price > index price
        // before:
        //  - market price: 99.9999999998
        //  - spread: 0
        // after:
        //  - market price: 110.1450249998
        //  - spread: 101450 (10.1450 %)
        vm.prank(address(trader));
        vm.expectRevert(bytes("EX_OPB"));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: false,
                isExactInput: true,
                amount: 1000 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );
    }

    // before in range, after out of range
    function test_open_short_position_when_before_in_range_but_after_our_of_range() public {
        // open long position => market price > index price
        // before:
        //  - market price: 99.9999999998
        //  - spread: 0
        // after:
        //  - market price: 88.9996440013
        //  - spread: 110003 (11.0003 %)
        vm.prank(address(trader));
        vm.expectRevert(bytes("EX_OPB"));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: true,
                isExactInput: true,
                amount: 12 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );
    }

    // before out of range, after spread less than before spread
    function test_open_long_position_when_before_out_of_range_and_after_spread_less_than_before_spread() public {
        // set price band to zero, and dump market price, let price spread > 10%
        exchange.setPriceBand(address(baseToken), 0);

        for (uint256 i = 0; i < 6; i++) {
            vm.prank(address(trader));
            clearingHouse.openPosition(
                IClearingHouse.OpenPositionParams({
                    baseToken: address(baseToken),
                    isBaseToQuote: true,
                    isExactInput: true,
                    amount: 2 ether,
                    oppositeAmountBound: 0,
                    deadline: block.timestamp,
                    sqrtPriceLimitX96: 0,
                    referralCode: ""
                })
            );
            vm.warp(block.timestamp + 15);
        }

        // set price band to 10% and open short position
        exchange.setPriceBand(address(baseToken), 0.1e6);

        // before:
        //  - market price: 88.9996440013
        //  - spread: 110003 (11.0003 %)
        // after:
        //  - market price: 89.8452415712
        //  - spread: 101547 (10.1547 %), still > 10% but less than before spread
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: false,
                isExactInput: false,
                amount: 1 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );
    }

    // before out of range, after spread less than before spread
    function test_open_short_position_when_before_out_of_range_and_after_spread_less_than_before_spread() public {
        // set price band to zero, and pump market price, let price spread > 10%
        exchange.setPriceBand(address(baseToken), 0);

        for (uint256 i = 0; i < 6; i++) {
            vm.prank(address(trader));
            clearingHouse.openPosition(
                IClearingHouse.OpenPositionParams({
                    baseToken: address(baseToken),
                    isBaseToQuote: false,
                    isExactInput: true,
                    amount: 200 ether,
                    oppositeAmountBound: 0,
                    deadline: block.timestamp,
                    sqrtPriceLimitX96: 0,
                    referralCode: ""
                })
            );
            vm.warp(block.timestamp + 15);
        }

        // set price band to 10% and open short position
        exchange.setPriceBand(address(baseToken), 0.1e6);

        // before:
        //  - market price: 112.2328359998
        //  - spread: 122328 (12.2328 %)
        // after:
        //  - market price: 110.1028370201
        //  - spread: 101028 (10.1028 %), still > 10% but less than before spread
        vm.prank(address(trader));
        clearingHouse.openPosition(
            IClearingHouse.OpenPositionParams({
                baseToken: address(baseToken),
                isBaseToQuote: true,
                isExactInput: false,
                amount: 200 ether,
                oppositeAmountBound: 0,
                deadline: block.timestamp,
                sqrtPriceLimitX96: 0,
                referralCode: ""
            })
        );
    }
}
