pragma solidity 0.7.6;
pragma abicoder v2;

import "../helper/Setup.sol";
import "../helper/Constant.sol";
import "../../../contracts/ClearingHouse.sol";
import "../interface/IMarketRegistryEvent.sol";
import { IUniswapV3Factory } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import { IUniswapV3PoolState } from "@uniswap/v3-core/contracts/interfaces/pool/IUniswapV3PoolState.sol";
import { UniswapV3Pool } from "@uniswap/v3-core/contracts/UniswapV3Pool.sol";
import { ILegacyMarketRegistry } from "./ILegacyMarketRegistry.sol";

contract MarketRegistryAddPoolTest is IMarketRegistryEvent, Setup {
    function setUp() public virtual override {
        Setup.setUp();
    }

    function test_addPool_should_emit_event() public {
        // add first pool
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(100, 0, 0, 0, 0, 0, false)
        );

        vm.expectEmit(true, true, true, true, address(marketRegistry));
        emit PoolAdded(address(baseToken), _DEFAULT_POOL_FEE, address(pool));
        marketRegistry.addPool(address(baseToken), _DEFAULT_POOL_FEE);
        assertEq(marketRegistry.getPool(address(baseToken)), address(pool));

        // add second pool
        vm.mockCall(
            address(pool2),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(100, 0, 0, 0, 0, 0, false)
        );
        vm.expectEmit(true, true, true, true, address(marketRegistry));
        emit PoolAdded(address(baseToken2), _DEFAULT_POOL_FEE, address(pool2));
        marketRegistry.addPool(address(baseToken2), _DEFAULT_POOL_FEE);
        assertEq(marketRegistry.getPool(address(baseToken2)), address(pool2));
    }

    function test_revert_addPool_if_pool_is_not_initialized() public {
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(0, 0, 0, 0, 0, 0, false)
        );
        vm.expectRevert(bytes("MR_PNI"));
        marketRegistry.addPool(address(baseToken), _DEFAULT_POOL_FEE);
    }

    function test_revert_addPool_if_pool_does_not_exist() public {
        vm.mockCall(
            address(uniswapV3Factory),
            abi.encodeWithSelector(IUniswapV3Factory.getPool.selector),
            abi.encode(0)
        );
        vm.expectRevert(bytes("MR_NEP"));
        marketRegistry.addPool(address(baseToken2), _DEFAULT_POOL_FEE);
    }

    function test_revert_addPool_if_pool_already_exists_in_ClearingHouse() public {
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(100, 0, 0, 0, 0, 0, false)
        );
        marketRegistry.addPool(address(baseToken), _DEFAULT_POOL_FEE);
        // should be failed if try to add poll again
        vm.expectRevert(bytes("MR_EP"));
        marketRegistry.addPool(address(baseToken), _DEFAULT_POOL_FEE);
    }

    function test_revert_addPool_with_same_base_quote_but_diff_uniswap_fee() public {
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(100, 0, 0, 0, 0, 0, false)
        );
        marketRegistry.addPool(address(baseToken), _DEFAULT_POOL_FEE);

        // create another uniswapPool with different fee
        _create_UniswapV3Pool(uniswapV3Factory, baseToken, quoteToken, 10000);

        vm.expectRevert(bytes("MR_EP"));
        marketRegistry.addPool(address(baseToken), 10000);
    }

    function test_revert_addPool_if_base_address_is_greater_than_quote_address() public {
        // test different base and quote address order, so we re-create token2 and init
        BaseToken baseToken2 =
            _create_BaseToken(_BASE_TOKEN_2_NAME, address(quoteToken), _BASE_TOKEN_2_PRICE_FEED, true);
        baseToken2.mintMaximumTo(address(clearingHouse));
        IUniswapV3Pool pool2 = _create_UniswapV3Pool(uniswapV3Factory, baseToken2, quoteToken, _DEFAULT_POOL_FEE);
        vm.mockCall(
            address(pool2),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(100, 0, 0, 0, 0, 0, false)
        );
        vm.expectRevert(bytes("MR_IB"));
        marketRegistry.addPool(address(baseToken2), _DEFAULT_POOL_FEE);
    }

    function test_revert_addPool_if_clearingHouse_has_insufficient_base_token_balance() public {
        BaseToken baseToken2 = _create_BaseToken("BASE2", address(quoteToken), makeAddr("FAKE"), false);
        IUniswapV3Pool pool2 = _create_UniswapV3Pool(uniswapV3Factory, baseToken2, quoteToken, _DEFAULT_POOL_FEE);
        vm.mockCall(
            address(pool2),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(100, 0, 0, 0, 0, 0, false)
        );
        vm.expectRevert(bytes("MR_CHBNE"));
        marketRegistry.addPool(address(baseToken2), _DEFAULT_POOL_FEE);
    }
}

contract MarketRegistrySetterTest is IMarketRegistryEvent, Setup, Constant {
    uint24 private constant _ONE_HUNDRED_PERCENT_RATIO = 1e6;

    function setUp() public virtual override {
        Setup.setUp();
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(100, 0, 0, 0, 0, 0, false)
        );
        marketRegistry.addPool(address(baseToken), _DEFAULT_POOL_FEE);
    }

    function test_setClearingHouse_should_emit_event() public {
        ClearingHouse clearingHouse2 =
            _create_ClearingHouse(
                address(clearingHouseConfig),
                address(vault),
                address(quoteToken),
                address(uniswapV3Factory),
                address(exchange),
                address(accountBalance),
                address(insuranceFund)
            );
        vm.expectEmit(true, false, false, true, address(marketRegistry));
        emit ClearingHouseChanged(address(clearingHouse2));
        marketRegistry.setClearingHouse(address(clearingHouse2));
        assertEq(marketRegistry.getClearingHouse(), address(clearingHouse2));
    }

    function test_revert_setClearingHouse_if_called_by_non_owner() public {
        ClearingHouse clearingHouse2 =
            _create_ClearingHouse(
                address(clearingHouseConfig),
                address(vault),
                address(quoteToken),
                address(uniswapV3Factory),
                address(exchange),
                address(accountBalance),
                address(insuranceFund)
            );
        vm.expectRevert(bytes("SO_CNO"));
        vm.prank(nonOwnerAddress);
        marketRegistry.setClearingHouse(address(clearingHouse2));
    }

    function test_setMaxOrdersPerMarket_should_emit_event(uint8 maxOrdersPerMarket) public {
        vm.expectEmit(false, false, false, true, address(marketRegistry));
        emit MaxOrdersPerMarketChanged(maxOrdersPerMarket);
        marketRegistry.setMaxOrdersPerMarket(maxOrdersPerMarket);
        assertEq(uint256(marketRegistry.getMaxOrdersPerMarket()), maxOrdersPerMarket);
    }

    function test_revert_setMaxOrdersPerMarket_if_called_by_non_owner() public {
        vm.expectRevert(bytes("SO_CNO"));
        vm.prank(nonOwnerAddress);
        marketRegistry.setMaxOrdersPerMarket(1);
    }

    function test_setFeeRatio_should_emit_event(uint24 feeRatio) public {
        vm.assume(feeRatio <= _ONE_HUNDRED_PERCENT_RATIO);
        vm.expectEmit(false, false, false, true, address(marketRegistry));
        emit FeeRatioChanged(address(baseToken), feeRatio);
        marketRegistry.setFeeRatio(address(baseToken), feeRatio);
    }

    function test_setFeeManager_should_emit_event(uint24 feeRatio) public {
        vm.assume(feeRatio <= _ONE_HUNDRED_PERCENT_RATIO);
        address feeManager = makeAddr("FeeManager");

        // First set will emit events.
        vm.expectEmit(false, false, false, true, address(marketRegistry));
        emit FeeManagerChanged(feeManager, true);
        marketRegistry.setFeeManager(feeManager, true);

        // Second set will still pass, but no events. Unfortunately there's no vm.expectNotEmit() to verify this.
        marketRegistry.setFeeManager(feeManager, true);

        // First unset will emit events.
        vm.expectEmit(false, false, false, true, address(marketRegistry));
        emit FeeManagerChanged(feeManager, false);
        marketRegistry.setFeeManager(feeManager, false);
    }

    function test_revert_setFeeRatio_if_called_by_non_owner() public {
        vm.expectRevert(bytes("SO_CNO"));
        vm.prank(nonOwnerAddress);
        marketRegistry.setFeeRatio(address(baseToken), _ONE_HUNDRED_PERCENT_RATIO);
    }

    function test_revert_setFeeRatio_if_overflow(uint24 feeRatio) public {
        vm.assume(feeRatio > _ONE_HUNDRED_PERCENT_RATIO);
        vm.expectRevert(bytes("MR_RO"));
        marketRegistry.setFeeRatio(address(baseToken), feeRatio);
    }

    function test_revert_setFeeRatio_if_pool_does_not_exist_in_ClearingHouse() public {
        BaseToken baseToken2 = _create_BaseToken("BASE2", address(quoteToken), address(clearingHouse), false);
        vm.expectRevert(bytes("MR_PNE"));
        marketRegistry.setFeeRatio(address(baseToken2), _ONE_HUNDRED_PERCENT_RATIO);
    }

    function test_setInsuranceFundFeeRatio_should_emit_event(uint24 feeRatio) public {
        vm.assume(feeRatio <= _ONE_HUNDRED_PERCENT_RATIO);
        vm.expectEmit(false, false, false, true, address(marketRegistry));
        emit InsuranceFundFeeRatioChanged(address(baseToken), feeRatio);
        marketRegistry.setInsuranceFundFeeRatio(address(baseToken), feeRatio);
    }

    function test_revert_setInsuranceFundFeeRatio_if_called_by_non_owner() public {
        vm.expectRevert(bytes("SO_CNO"));
        vm.prank(nonOwnerAddress);
        marketRegistry.setInsuranceFundFeeRatio(address(baseToken), _ONE_HUNDRED_PERCENT_RATIO);
    }

    function test_revert_setInsuranceFundFeeRatio_if_overflow(uint24 feeRatio) public {
        vm.assume(feeRatio > _ONE_HUNDRED_PERCENT_RATIO);
        vm.expectRevert(bytes("MR_RO"));
        marketRegistry.setInsuranceFundFeeRatio(address(baseToken), feeRatio);
    }

    function test_revert_setInsuranceFundFeeRatio_if_pool_does_not_exist_in_ClearingHouse() public {
        BaseToken baseToken2 = _create_BaseToken("BASE2", address(quoteToken), address(clearingHouse), false);
        vm.expectRevert(bytes("MR_PNE"));
        marketRegistry.setInsuranceFundFeeRatio(address(baseToken2), _ONE_HUNDRED_PERCENT_RATIO);
    }

    function test_setMarketMaxPriceSpreadRatio() public {
        vm.expectEmit(true, true, true, true, address(marketRegistry));
        emit MarketMaxPriceSpreadRatioChanged(address(baseToken), 0.2e6);
        marketRegistry.setMarketMaxPriceSpreadRatio(address(baseToken), 0.2e6);
    }

    function test_revert_setMarketMaxPriceSpreadRatio_when_not_owner() public {
        address notOwner = makeAddr("NotOwner");
        vm.expectRevert(bytes("SO_CNO"));
        vm.prank(notOwner);
        marketRegistry.setMarketMaxPriceSpreadRatio(address(baseToken), 0.2e6);
    }

    function test_getMarketMaxPriceSpreadRatio_when_not_set() public {
        assertEq(uint256(marketRegistry.getMarketMaxPriceSpreadRatio(address(baseToken))), 0.1e6);
    }

    function test_getMarketMaxPriceSpreadRatio_when_set() public {
        marketRegistry.setMarketMaxPriceSpreadRatio(address(baseToken), 0.2e6);
        assertEq(uint256(marketRegistry.getMarketMaxPriceSpreadRatio(address(baseToken))), 0.2e6);
    }

    function test_getMarketInfo() public {
        IMarketRegistry.MarketInfo memory marketInfo = marketRegistry.getMarketInfo(address(baseToken));
        assertEq(marketInfo.pool, address(pool));
        assertEq(uint256(marketInfo.exchangeFeeRatio), _DEFAULT_POOL_FEE);
        assertEq(uint256(marketInfo.uniswapFeeRatio), _DEFAULT_POOL_FEE);
        assertEq(uint256(marketInfo.insuranceFundFeeRatio), 0);
        assertEq(uint256(marketInfo.maxPriceSpreadRatio), 0.1e6);
    }

    function test_getMarketInfo_legacy_struct() public {
        ILegacyMarketRegistry.LegacyMarketInfo memory legacyMarketInfo =
            ILegacyMarketRegistry(address(marketRegistry)).getMarketInfo(address(baseToken));
        assertEq(legacyMarketInfo.pool, address(pool));
        assertEq(uint256(legacyMarketInfo.exchangeFeeRatio), _DEFAULT_POOL_FEE);
        assertEq(uint256(legacyMarketInfo.uniswapFeeRatio), _DEFAULT_POOL_FEE);
        assertEq(uint256(legacyMarketInfo.insuranceFundFeeRatio), 0);
    }

    function test_setFeeDiscountRatio_by_fee_manager() public {
        address feeManager = makeAddr("FeeManager");
        marketRegistry.setFeeManager(feeManager, true);

        address trader = makeAddr("Trader");
        uint24 discountRatio = 1e6;

        vm.expectEmit(false, false, false, true, address(marketRegistry));
        emit FeeDiscountRatioChanged(trader, discountRatio);

        vm.prank(feeManager);
        marketRegistry.setFeeDiscountRatio(trader, discountRatio);
    }

    function test_revert_setFeeDiscountRatio_if_called_by_non_fee_manager() public {
        address nonFeeManager = makeAddr("NonFeeManager");
        vm.expectRevert(bytes("MR_OFM"));
        vm.prank(nonOwnerAddress);
        marketRegistry.setFeeDiscountRatio(nonFeeManager, 0.1e6); // Parameters don't matter
    }

    function test_getMarketInfoByTrader_and_setFeeDiscountRatio() public {
        address bob = makeAddr("Bob");
        address alice = makeAddr("Alice");

        IMarketRegistry.MarketInfo memory marketInfoBefore =
            marketRegistry.getMarketInfoByTrader(bob, address(baseToken));

        // 10% off
        vm.expectEmit(true, true, true, true, address(marketRegistry));
        emit FeeDiscountRatioChanged(bob, 0.1e6);
        marketRegistry.setFeeDiscountRatio(bob, 0.1e6);

        IMarketRegistry.MarketInfo memory marketInfoAfter =
            marketRegistry.getMarketInfoByTrader(bob, address(baseToken));

        vm.expectEmit(true, true, true, true, address(marketRegistry));
        emit FeeDiscountRatioChanged(bob, 0);
        marketRegistry.setFeeDiscountRatio(bob, 0);

        IMarketRegistry.MarketInfo memory marketInfoFinal =
            marketRegistry.getMarketInfoByTrader(bob, address(baseToken));

        assertEq(uint256(marketInfoBefore.exchangeFeeRatio), _DEFAULT_POOL_FEE);
        assertEq(uint256(marketInfoAfter.exchangeFeeRatio), (uint256(_DEFAULT_POOL_FEE) * 0.9e6) / 1e6);
        assertEq(uint256(marketInfoFinal.exchangeFeeRatio), _DEFAULT_POOL_FEE);

        IMarketRegistry.MarketInfo memory aliceMarketInfo =
            marketRegistry.getMarketInfoByTrader(alice, address(baseToken));

        assertEq(uint256(aliceMarketInfo.exchangeFeeRatio), _DEFAULT_POOL_FEE);
    }
}
