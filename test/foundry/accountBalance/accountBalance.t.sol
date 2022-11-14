pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "../helper/Setup.sol";
import "../../../contracts/interface/IIndexPrice.sol";

contract AccountBalanceTest is Setup {
    function setUp() public virtual override {
        Setup.setUp();
    }

    function test_getMarkPrice_should_return_index_twap_if_marketRegistry_not_set() public {
        uint32 indexTwapInterval = clearingHouseConfig.getTwapInterval();
        // mock index twap
        uint256 indexTwap = 100;
        vm.mockCall(
            address(baseToken),
            abi.encodeWithSelector(IIndexPrice.getIndexPrice.selector, abi.encode(indexTwapInterval)),
            abi.encode(indexTwap)
        );
        assertEq(accountBalance.getMarkPrice(address(baseToken)), indexTwap);

        /*
        vm.expectEmit(true, true, true, true, address(marketRegistry));
        emit PoolAdded(address(baseToken), _DEFAULT_POOL_FEE, address(pool));
        marketRegistry.addPool(address(baseToken), _DEFAULT_POOL_FEE);
        assertEq(marketRegistry.getPool(address(baseToken)), address(pool));

        // create another token and pool
        BaseToken baseToken2 = _create_BaseToken("BASE2", address(quoteToken), address(clearingHouse), false);
        UniswapV3Pool pool2 = _create_UniswapV3Pool(uniswapV3Factory, baseToken2, quoteToken, _DEFAULT_POOL_FEE);

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
        */
    }
}
